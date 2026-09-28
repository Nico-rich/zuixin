import { Inject, Injectable, Logger } from '@nestjs/common';
import { HealthStatus, Prisma, RoutingDecision } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BreakerConfig, BreakerState, CircuitBreakerService } from '../../core/circuit-breaker/circuit-breaker.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { mapProviderError, ProviderLikeError } from '../../common/errors/provider-error';
import { estimateCost } from './cost-estimator';
import { modelSupports } from './capability-match';
import { healthScore, stableHash } from './health-score';
import {
  CAPABILITY_PROVIDER_TYPES, CandidateReasonCode, CostBudget, DEFAULT_BREAKER_COOLDOWN_SEC, DEFAULT_BREAKER_FAILURE_THRESHOLD,
  DEFAULT_MAX_FALLBACKS, DEFAULT_POLICY_PRIORITY, DecisionReasonCode, FILTER_TO_DECISION_REASON, RouteInput,
  RouteResult, RouteTarget, ROUTING_CAPABILITY_SET, RoutingCandidateRecord, RoutingCapability,
} from './provider-routing.types';

type ProviderWithModels = Prisma.ProviderGetPayload<{ include: { models: true } }>;
type ModelRow = ProviderWithModels['models'][number];

/** 延迟采样窗口（只读事实：usage_records.latencyMs 聚合；不新建事实表） */
const LATENCY_WINDOW_MS = 24 * 3600_000;

/** 无观测事实的候选（评分为「无样本」中性值，绝不臆造延迟/失败率） */
const NO_FACTS: ProviderFacts = { latencyMs: null, windowFailures: 0, windowSuccesses: 0 };

interface ProviderFacts {
  latencyMs: number | null;
  windowFailures: number;
  windowSuccesses: number;
}

/** 通过全部过滤、进入排序/回退链的候选 */
interface AcceptedCandidate extends RouteTarget {
  tier: number;        // 0 = 偏好模型，1 = 组织策略显式 allow，2 = 未列名
  preferredRank: number; // 偏好清单内序号（未列名 = Number.MAX_SAFE_INTEGER）
}

/**
 * M8-P7 智能 Provider 路由（服务端 deterministic；LLM 只表达能力需求，选择权在服务端）。
 *
 * 管道：候选收集（能力匹配）→ 策略过滤（deny 硬剔除 / allow 优先组 / 请求级成本上限）
 *      → 健康过滤 → 熔断过滤（open 剔除；half_open 抢占单飞探测槽）
 *      → 排序（偏好/策略 → provider 优先级 → 软能力命中 → 健康分 → 成本 → 延迟 → 稳定 tie-break）
 *      → 选择 + 回退链 → 审计落库。
 *
 * M9-P3 生产接线：本服务是 LLM / Image / Video / Embedding 四条调用链的**唯一 provider 选择入口**
 * （决策输入全部为服务端事实：capability / health / latency / cost / org policy / breaker 状态；
 *  LLM 不参与，也无权指定 provider）。排序维度的评分全部来自既有只读事实——不新建事实表：
 *  - 健康分：Provider.healthStatus 基分 - 熔断窗口失败率罚分 - usage_records.latencyMs 最近均值罚分；
 *  - 偏好组：systemSetting.routingPolicy.defaults.*（运营者配置，只影响排序，不做硬过滤）。
 *
 * 与冻结模块的边界：不改 ModelResolver/LLMManager（那是“按 id 解析具体模型”的既有能力），
 * 本服务是独立的“按能力选 provider”决策层，二者可并存；成本上限用 ProviderPolicy 自有字段，不与配额耦合。
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger('ProviderRouting');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CircuitBreakerService) private readonly breaker: CircuitBreakerService,
  ) {}

  async route(input: RouteInput): Promise<RouteResult> {
    if (!ROUTING_CAPABILITY_SET.has(input.capability)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `不支持的路由能力：${String(input.capability)}`);
    }
    const capability = input.capability;
    const organizationId = input.organizationId ?? null;
    const budget = input.budget ?? {};
    const preferCapabilities = (input.preferCapabilities ?? []).filter((c) => ROUTING_CAPABILITY_SET.has(c));
    const preferredRank = new Map((input.preferredModelIds ?? []).map((id, index) => [id, index]));

    const [providers, declared, policies] = await Promise.all([
      this.prisma.provider.findMany({
        where: { type: { in: CAPABILITY_PROVIDER_TYPES[capability] } },
        include: { models: { where: { enabled: true }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] } },
        orderBy: { id: 'asc' },
      }),
      this.prisma.providerCapability.findMany({ where: { capability }, select: { providerId: true } }),
      this.prisma.providerPolicy.findMany({ where: { organizationId, enabled: true } }),
    ]);
    const declaredProviderIds = new Set(declared.map((d) => d.providerId));
    const policyByProvider = new Map(policies.map((p) => [p.providerId, p]));
    // 只读观测事实（延迟采样 + 熔断窗口计数）：取不到就按「无样本」处理——观测面绝不阻断路由
    const factsByProvider = await this.collectFacts(providers.map((p) => p.id));

    const candidates: RoutingCandidateRecord[] = [];
    const accepted: AcceptedCandidate[] = [];

    for (const provider of providers) {
      const matched = provider.models.filter((m) => modelSupports(m, capability));
      // 能力不匹配（既无平台声明、也无合格模型）→ 根本不该成为候选，不入审计清单
      if (matched.length === 0 && !declaredProviderIds.has(provider.id)) continue;

      const policy = policyByProvider.get(provider.id) ?? null;
      const facts = factsByProvider.get(provider.id) ?? NO_FACTS;
      // 熔断状态是评分与准入的共同输入（只读派生：openedAt 时间戳；无进程内状态）
      const breakerConfig = this.breakerConfigOf(provider);
      const breakerState = await this.breaker.state(provider.id, breakerConfig);
      const score = this.scoreOf(provider, facts, breakerState);
      const record: RoutingCandidateRecord = {
        providerId: provider.id,
        providerName: provider.name,
        modelId: null,
        modelName: null,
        estimatedCost: null,
        allowListed: policy?.allow === true,
        policyId: policy?.id ?? null,
        policyPriority: policy?.priority ?? DEFAULT_POLICY_PRIORITY,
        providerPriority: provider.priority,
        healthStatus: provider.healthStatus,
        breakerState,
        healthScore: score,
        latencyMs: facts.latencyMs,
        windowFailures: facts.windowFailures,
        windowSuccesses: facts.windowSuccesses,
        capabilityFit: 0,
        accepted: false,
        reasonCode: 'no_model',
      };
      const reject = (reasonCode: CandidateReasonCode) => { record.reasonCode = reasonCode; candidates.push(record); };

      // 该 provider 的最优合格模型：priority 升序（查询已排序）→ 软能力命中 → 估算成本 → id
      // （先算成本再判 enabled：审计行对“本来更便宜但被停用”的 provider 也能给出价格）
      const best = this.pickModel(matched, capability, budget, preferCapabilities);
      if (!best) { reject('no_model'); continue; }
      record.modelId = best.model.id;
      record.modelName = best.model.name;
      record.estimatedCost = best.estimatedCost;
      record.capabilityFit = best.capabilityFit;

      if (!provider.enabled) { reject('disabled'); continue; }

      // 策略过滤（deny 硬剔除：被组织禁止的 provider 绝不承载该组织的数据）
      if (policy && policy.allow === false) { reject('policy_deny'); continue; }
      const ceiling = policy?.costCeilingPerRequest ?? null;
      if (ceiling != null && best.estimatedCost > ceiling) { reject('cost_ceiling'); continue; }

      // 健康过滤
      if (provider.healthStatus === HealthStatus.unhealthy) { reject('unhealthy'); continue; }

      // 熔断过滤（真实 API：state() → healthy | open | half_open；half_open 视为探测放行）
      if (breakerState === 'open') { reject('circuit_open'); continue; }
      // Pre-M9 G1 半开单飞（与 ModelRouter 同一守卫）：抢占探测槽，避免冷却到期瞬间探测风暴；
      // 槽被别的在途探测占用 → 本刻不可调用（跳过，冷却窗内不重复探测）。
      if (breakerState === 'half_open' && !(await this.breaker.canProbe(provider.id, breakerConfig))) {
        reject('circuit_open');
        continue;
      }

      record.accepted = true;
      record.reasonCode = 'fallback'; // 先进回退链；最终选中者改为 selected
      candidates.push(record);
      accepted.push({
        providerId: provider.id,
        providerName: provider.name,
        adapter: provider.adapter,
        modelId: best.model.id,
        modelName: best.model.name,
        apiModelId: best.model.apiModelId,
        estimatedCost: best.estimatedCost,
        policyId: policy?.id ?? null,
        allowListed: policy?.allow === true,
        policyPriority: policy?.priority ?? DEFAULT_POLICY_PRIORITY,
        providerPriority: provider.priority,
        healthStatus: provider.healthStatus,
        breakerState,
        modelCapabilities: (best.model.capabilities ?? {}) as Record<string, unknown>,
        capabilityFit: best.capabilityFit,
        healthScore: score,
        latencyMs: facts.latencyMs,
        tier: preferredRank.has(best.model.id) ? 0 : policy?.allow === true ? 1 : 2,
        preferredRank: preferredRank.get(best.model.id) ?? Number.MAX_SAFE_INTEGER,
      });
    }

    accepted.sort((a, b) => compareRank(a, b, input.stickyKey));

    if (accepted.length === 0) {
      // 先落审计再抛错：无可用 provider 也是一次决策（谁被拒、为什么）
      await this.writeDecision({
        input, capability, organizationId, candidates, providerId: null,
        reasonCode: 'denied', policyId: null, estimatedCost: null,
      });
      const reasons = [...new Set(candidates.map((c) => c.reasonCode))].join('/') || 'no_candidate';
      this.logger.warn({ capability, organizationId, reasons }, '无可用 provider');
      throw new AppError(
        ErrorCode.PROVIDER_UNAVAILABLE,
        `没有可用的 provider 承载能力 ${capability}（拒绝原因：${reasons}）`, input.requestId,
      );
    }

    const winner = accepted[0];
    const runnerUp = accepted[1] ?? null;
    const reasonCode = deriveDecisionReason(winner, runnerUp, candidates);
    const selected = candidates.find((c) => c.providerId === winner.providerId);
    if (selected) selected.reasonCode = 'selected';

    const decisionId = await this.writeDecision({
      input, capability, organizationId, candidates, providerId: winner.providerId,
      reasonCode, policyId: winner.policyId, estimatedCost: winner.estimatedCost,
    });

    const chain: RouteTarget[] = accepted.slice(0, 1 + DEFAULT_MAX_FALLBACKS).map(stripTier);
    this.logger.log(
      { capability, organizationId, decisionId, providerId: winner.providerId, reasonCode },
      '路由决策',
    );
    return {
      decisionId, capability,
      providerId: winner.providerId, providerName: winner.providerName,
      modelId: winner.modelId, apiModelId: winner.apiModelId, adapter: winner.adapter,
      reasonCode, estimatedCost: winner.estimatedCost, policyId: winner.policyId,
      chain, candidates,
      invoke: (fn, opts) => this.invoke(
        decisionId, chain, opts?.maxFallbacks ?? DEFAULT_MAX_FALLBACKS, opts?.retryableOnly ?? false, fn,
      ),
    };
  }

  /**
   * 决策审计（org 校验在 controller 层完成——服务层只管数据）。
   * `organizationIds` 用于“只给了 runId”的场景：只回请求者所属组织的决策（平台级无组织决策不返回，
   * 避免越权读取）。
   */
  async listDecisions(
    filter: { organizationId?: string | null; organizationIds?: string[]; runId?: string; limit?: number },
  ): Promise<RoutingDecision[]> {
    const where: Prisma.RoutingDecisionWhereInput = {};
    if (filter.organizationId !== undefined) where.organizationId = filter.organizationId;
    if (filter.organizationIds) where.organizationId = { in: filter.organizationIds };
    if (filter.runId) where.runId = filter.runId;
    return this.prisma.routingDecision.findMany({
      where,
      orderBy: { decidedAt: 'desc' },
      take: Math.min(Math.max(filter.limit ?? 50, 1), 200),
    });
  }

  /**
   * 回退实际承载了调用 → 决策行改写为实际使用的 provider（reasonCode=fallback），审计与事实一致。
   * 供**自持重试语义**的调用方使用（Agent 引擎自行管理「同 provider 重试 / 换 provider 回退」与熔断计数）：
   * 与 invoke() 的回退改写同一语义，但**绝不触碰熔断计数**（调用方是计数的唯一写入者，避免双计）。
   */
  async recordFallback(decisionId: string, target: RouteTarget): Promise<void> {
    await this.prisma.routingDecision.update({
      where: { id: decisionId },
      data: {
        providerId: target.providerId, reasonCode: 'fallback',
        policyId: target.policyId, estimatedCost: target.estimatedCost,
      },
    }).catch((err) => this.logger.warn({ err, decisionId }, '回退决策改写失败'));
  }

  /**
   * 回退调用句柄：按链顺序调用；失败 → 喂熔断器计数 → 下一个候选（最多 maxFallbacks 次）。
   * 全部失败 → 抛出最后一次错误（调用方决定如何降级），绝不静默返回空结果。
   * `retryableOnly`：不可重试错误（参数/鉴权类）立即停止回退——换 provider 也救不回来。
   */
  private async invoke<T>(
    decisionId: string, chain: RouteTarget[], maxFallbacks: number, retryableOnly: boolean,
    fn: (target: RouteTarget, attempt: number) => Promise<T>,
  ): Promise<T> {
    const attempts = chain.slice(0, Math.max(1, maxFallbacks + 1));
    let lastError: unknown;
    for (let i = 0; i < attempts.length; i++) {
      const target = attempts[i];
      try {
        const result = await fn(target, i);
        await this.breaker.recordSuccess(target.providerId);
        if (i > 0) await this.recordFallback(decisionId, target);
        return result;
      } catch (err) {
        lastError = err;
        await this.breaker.recordFailure(target.providerId);
        const appErr = err instanceof AppError ? err : mapProviderError(err as ProviderLikeError);
        if (retryableOnly && !appErr.retryable) break;
        this.logger.warn(
          { decisionId, providerId: target.providerId, attempt: i },
          `provider 调用失败，${i + 1 < attempts.length ? '切换回退候选' : '回退链耗尽'}`,
        );
      }
    }
    throw lastError;
  }

  /** provider 内挑最优合格模型：priority 升序 → 软能力命中（多者优先）→ 估算成本 → id（确定性） */
  private pickModel(
    models: ModelRow[], capability: RoutingCapability, budget: CostBudget, preferCapabilities: RoutingCapability[],
  ) {
    const priced = models
      .map((model) => ({
        model,
        estimatedCost: estimateCost(capability, model, budget),
        capabilityFit: preferCapabilities.filter((c) => modelSupports(model, c)).length,
      }))
      .sort((a, b) =>
        a.model.priority - b.model.priority ||
        b.capabilityFit - a.capabilityFit ||
        a.estimatedCost - b.estimatedCost ||
        (a.model.id < b.model.id ? -1 : 1));
    return priced[0] ?? null;
  }

  /**
   * 只读事实采集（不新建事实表，绝无写入）：
   * - 延迟：usage_records.latencyMs 在窗口内的均值（按 providerId 聚合）；
   * - 失败率：熔断器 KV 窗口内的失败/成功计数。
   * 任一观测面故障 → 该 provider 退回「无样本」中性分（观测绝不阻断路由决策）。
   */
  private async collectFacts(providerIds: string[]): Promise<Map<string, ProviderFacts>> {
    const map = new Map<string, ProviderFacts>();
    if (providerIds.length === 0) return map;
    const since = new Date(Date.now() - LATENCY_WINDOW_MS);
    const [latencyRows, windowRows] = await Promise.all([
      this.prisma.usageRecord.groupBy({
        by: ['providerId'],
        where: { providerId: { in: providerIds }, latencyMs: { not: null }, createdAt: { gte: since } },
        _avg: { latencyMs: true },
      }).catch((err) => {
        this.logger.warn(`延迟采样聚合失败（按无样本处理）: ${(err as Error).message}`);
        return [] as Array<{ providerId: string | null; _avg: { latencyMs: number | null } }>;
      }),
      Promise.all(providerIds.map(async (id) => [id, await this.breaker.windowStats(id)] as const)),
    ]);
    const latencyByProvider = new Map(
      latencyRows.map((row) => [row.providerId, row._avg.latencyMs ?? null] as const),
    );
    for (const [providerId, window] of windowRows) {
      map.set(providerId, {
        latencyMs: latencyByProvider.get(providerId) ?? null,
        windowFailures: window.failures,
        windowSuccesses: window.successes,
      });
    }
    return map;
  }

  /**
   * 健康分（排序用；audit 行的 windowFailures/windowSuccesses 仍记录原始事实）。
   *
   * 失败率罚分只在熔断器 **healthy**（新调用仍被放行）时计入：open/half_open 期间没有新调用被放行，
   * 窗口计数是「触发熔断的那段历史」的残留而非新鲜观测——若照常折算，冷却到期的半开候选会永远
   * 排在健康候选之后，三态自愈的探测路径在有备选时不可达（探测槽/半开探测形同虚设）。
   * 延迟罚分照常计入（延迟样本来自真实调用事实，不因熔断状态失真）。
   */
  private scoreOf(provider: { healthStatus: HealthStatus }, facts: ProviderFacts, breakerState: BreakerState): number {
    const live = breakerState === 'healthy';
    return healthScore({
      healthStatus: provider.healthStatus,
      windowFailures: live ? facts.windowFailures : 0,
      windowSuccesses: live ? facts.windowSuccesses : 0,
      latencyMs: facts.latencyMs,
    });
  }

  private breakerConfigOf(provider: { retryConfig: Prisma.JsonValue | null }): BreakerConfig {    const bag = (provider.retryConfig ?? {}) as Record<string, unknown>;
    const cfg: BreakerConfig = {
      failureThreshold: DEFAULT_BREAKER_FAILURE_THRESHOLD, cooldownSec: DEFAULT_BREAKER_COOLDOWN_SEC,
    };
    const threshold = Number(bag.failureThreshold);
    const cooldown = Number(bag.cooldownSec);
    if (Number.isFinite(threshold) && threshold > 0) cfg.failureThreshold = threshold;
    if (Number.isFinite(cooldown) && cooldown > 0) cfg.cooldownSec = cooldown;
    return cfg;
  }

  private async writeDecision(args: {
    input: RouteInput; capability: RoutingCapability; organizationId: string | null;
    candidates: RoutingCandidateRecord[]; providerId: string | null;
    reasonCode: DecisionReasonCode; policyId: string | null; estimatedCost: number | null;
  }): Promise<string> {
    const row = await this.prisma.routingDecision.create({
      data: {
        organizationId: args.organizationId,
        requestId: args.input.requestId ?? null,
        traceId: args.input.traceId ?? null,
        runId: args.input.runId ?? null,
        taskId: args.input.taskId ?? null,
        capability: args.capability,
        providerId: args.providerId,
        candidates: args.candidates as unknown as Prisma.InputJsonValue,
        reasonCode: args.reasonCode,
        policyId: args.policyId,
        estimatedCost: args.estimatedCost,
      },
    });
    return row.id;
  }
}

/**
 * 排序（全维度服务端确定性）：
 * 偏好组/策略 allow 组 → 偏好序号 → 策略优先级 → provider 优先级 → 软能力命中 → 健康分
 * → 估算成本 → 最近延迟 → tie-break（stickyKey 稳定哈希，缺省 providerId 字典序）。
 */
function compareRank(a: AcceptedCandidate, b: AcceptedCandidate, stickyKey?: string): number {
  return a.tier - b.tier ||
    a.preferredRank - b.preferredRank ||
    a.policyPriority - b.policyPriority ||
    a.providerPriority - b.providerPriority ||
    b.capabilityFit - a.capabilityFit ||
    b.healthScore - a.healthScore ||
    a.estimatedCost - b.estimatedCost ||
    (a.latencyMs ?? Number.POSITIVE_INFINITY) - (b.latencyMs ?? Number.POSITIVE_INFINITY) ||
    tieBreak(a.providerId, b.providerId, stickyKey);
}

/** 末位 tie-break：有 stickyKey → 稳定哈希（同键同序、异键分摊）；否则 providerId 字典序（M8-P7 冻结语义） */
function tieBreak(a: string, b: string, stickyKey?: string): number {
  if (stickyKey) {
    const diff = stableHash(`${stickyKey}:${a}`) - stableHash(`${stickyKey}:${b}`);
    if (diff !== 0) return diff;
  }
  return a < b ? -1 : 1;
}

/** 审计用的 tier/preferredRank 不进入对外句柄（调用方只需 provider/模型/价格/事实） */
function stripTier(c: AcceptedCandidate): RouteTarget {
  const target = { ...c } as RouteTarget & { tier?: number; preferredRank?: number };
  delete target.tier;
  delete target.preferredRank;
  return target;
}

/** 决策级原因：优先解释“本可胜出却被过滤”的因素，其次解释胜出者凭什么胜出 */
export function deriveDecisionReason(
  winner: AcceptedCandidate, runnerUp: AcceptedCandidate | null, candidates: RoutingCandidateRecord[],
): DecisionReasonCode {
  const filtered = candidates
    .filter((c) => !c.accepted && c.estimatedCost != null && outranks(c, winner))
    .sort((a, b) =>
      (a.allowListed === b.allowListed ? 0 : a.allowListed ? -1 : 1) ||
      a.policyPriority - b.policyPriority ||
      a.providerPriority - b.providerPriority ||
      (a.estimatedCost ?? 0) - (b.estimatedCost ?? 0) ||
      (a.providerId < b.providerId ? -1 : 1));
  const blocked = filtered[0];
  if (blocked) return FILTER_TO_DECISION_REASON[blocked.reasonCode];

  if (winner.allowListed && runnerUp && !runnerUp.allowListed) return 'policy_allow';
  if (runnerUp && winner.policyPriority < runnerUp.policyPriority) return 'policy_allow';
  if (runnerUp && winner.healthScore > runnerUp.healthScore) return 'health_score';
  if (runnerUp && winner.estimatedCost < runnerUp.estimatedCost) return 'cost_optimal';
  return 'capability_match';
}

/**
 * 被过滤候选是否“本可排在胜出者之前”（严格优于才算法定因素）。
 * 偏好组/策略组语义：被过滤候选绝不属于偏好组（偏好模型只影响排序，不改变准入），
 * 故先比策略组，再逐维比较——胜出者属偏好组（tier 0）时，被过滤者一律不构成“决定性因素”。
 */
function outranks(candidate: RoutingCandidateRecord, winner: AcceptedCandidate): boolean {
  const tier = candidate.allowListed ? 1 : 2;
  if (tier !== winner.tier) return tier < winner.tier;
  if (candidate.policyPriority !== winner.policyPriority) return candidate.policyPriority < winner.policyPriority;
  if (candidate.providerPriority !== winner.providerPriority) return candidate.providerPriority < winner.providerPriority;
  if (candidate.capabilityFit !== winner.capabilityFit) return candidate.capabilityFit > winner.capabilityFit;
  return (candidate.estimatedCost ?? 0) < winner.estimatedCost;
}
