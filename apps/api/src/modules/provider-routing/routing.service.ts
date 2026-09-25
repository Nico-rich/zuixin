import { Inject, Injectable, Logger } from '@nestjs/common';
import { HealthStatus, Prisma, RoutingDecision } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BreakerConfig, CircuitBreakerService } from '../../core/circuit-breaker/circuit-breaker.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { estimateCost } from './cost-estimator';
import { modelSupports } from './capability-match';
import {
  CAPABILITY_PROVIDER_TYPES, CandidateReasonCode, CostBudget, DEFAULT_BREAKER_COOLDOWN_SEC, DEFAULT_BREAKER_FAILURE_THRESHOLD,
  DEFAULT_MAX_FALLBACKS, DEFAULT_POLICY_PRIORITY, DecisionReasonCode, FILTER_TO_DECISION_REASON, RouteInput,
  RouteResult, RouteTarget, ROUTING_CAPABILITY_SET, RoutingCandidateRecord, RoutingCapability,
} from './provider-routing.types';

type ProviderWithModels = Prisma.ProviderGetPayload<{ include: { models: true } }>;
type ModelRow = ProviderWithModels['models'][number];

/** 通过全部过滤、进入排序/回退链的候选 */
interface AcceptedCandidate extends RouteTarget {
  tier: number; // 0 = 组织策略显式 allow（优先组），1 = 未列名
}

/**
 * M8-P7 智能 Provider 路由（服务端 deterministic；LLM 只表达能力需求，选择权在服务端）。
 *
 * 管道：候选收集（能力匹配）→ 策略过滤（deny 硬剔除 / allow 优先组 / 请求级成本上限）
 *      → 健康过滤 → 熔断过滤 → 排序（策略优先级 → provider 优先级 → 成本）→ 选择 + 回退链 → 审计落库。
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

    const candidates: RoutingCandidateRecord[] = [];
    const accepted: AcceptedCandidate[] = [];

    for (const provider of providers) {
      const matched = provider.models.filter((m) => modelSupports(m, capability));
      // 能力不匹配（既无平台声明、也无合格模型）→ 根本不该成为候选，不入审计清单
      if (matched.length === 0 && !declaredProviderIds.has(provider.id)) continue;

      const policy = policyByProvider.get(provider.id) ?? null;
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
        breakerState: 'healthy',
        accepted: false,
        reasonCode: 'no_model',
      };
      const reject = (reasonCode: CandidateReasonCode) => { record.reasonCode = reasonCode; candidates.push(record); };

      // 该 provider 的最优合格模型：priority 升序（查询已排序）→ 同优先级取估算成本低者
      // （先算成本再判 enabled：审计行对“本来更便宜但被停用”的 provider 也能给出价格）
      const best = this.pickModel(matched, capability, budget);
      if (!best) { reject('no_model'); continue; }
      record.modelId = best.model.id;
      record.modelName = best.model.name;
      record.estimatedCost = best.estimatedCost;

      if (!provider.enabled) { reject('disabled'); continue; }

      // 策略过滤（deny 硬剔除：被组织禁止的 provider 绝不承载该组织的数据）
      if (policy && policy.allow === false) { reject('policy_deny'); continue; }
      const ceiling = policy?.costCeilingPerRequest ?? null;
      if (ceiling != null && best.estimatedCost > ceiling) { reject('cost_ceiling'); continue; }

      // 健康过滤
      if (provider.healthStatus === HealthStatus.unhealthy) { reject('unhealthy'); continue; }

      // 熔断过滤（真实 API：state() → healthy | open | half_open；half_open 视为探测放行）
      const breakerState = await this.breaker.state(provider.id, this.breakerConfigOf(provider));
      record.breakerState = breakerState;
      if (breakerState === 'open') { reject('circuit_open'); continue; }

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
        tier: policy?.allow === true ? 0 : 1,
      });
    }

    accepted.sort(compareRank);

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
      invoke: (fn, opts) => this.invoke(decisionId, chain, opts?.maxFallbacks ?? DEFAULT_MAX_FALLBACKS, fn),
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
   * 回退调用句柄：按链顺序调用；失败 → 喂熔断器计数 → 下一个候选（最多 maxFallbacks 次）。
   * 全部失败 → 抛出最后一次错误（调用方决定如何降级），绝不静默返回空结果。
   */
  private async invoke<T>(
    decisionId: string, chain: RouteTarget[], maxFallbacks: number,
    fn: (target: RouteTarget, attempt: number) => Promise<T>,
  ): Promise<T> {
    const attempts = chain.slice(0, Math.max(1, maxFallbacks + 1));
    let lastError: unknown;
    for (let i = 0; i < attempts.length; i++) {
      const target = attempts[i];
      try {
        const result = await fn(target, i);
        await this.breaker.recordSuccess(target.providerId);
        if (i > 0) {
          await this.prisma.routingDecision.update({
            where: { id: decisionId },
            data: {
              providerId: target.providerId, reasonCode: 'fallback',
              policyId: target.policyId, estimatedCost: target.estimatedCost,
            },
          }).catch((err) => this.logger.warn({ err, decisionId }, '回退决策改写失败'));
        }
        return result;
      } catch (err) {
        lastError = err;
        await this.breaker.recordFailure(target.providerId);
        this.logger.warn(
          { decisionId, providerId: target.providerId, attempt: i },
          `provider 调用失败，${i + 1 < attempts.length ? '切换回退候选' : '回退链耗尽'}`,
        );
      }
    }
    throw lastError;
  }

  /** provider 内挑最优合格模型：priority 升序 → 估算成本 → id（确定性） */
  private pickModel(models: ModelRow[], capability: RoutingCapability, budget: CostBudget) {
    const priced = models
      .map((model) => ({ model, estimatedCost: estimateCost(capability, model, budget) }))
      .sort((a, b) =>
        a.model.priority - b.model.priority ||
        a.estimatedCost - b.estimatedCost ||
        (a.model.id < b.model.id ? -1 : 1));
    return priced[0] ?? null;
  }

  private breakerConfigOf(provider: { retryConfig: Prisma.JsonValue | null }): BreakerConfig {
    const bag = (provider.retryConfig ?? {}) as Record<string, unknown>;
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

/** allow 优先组 → 策略优先级 → provider 优先级 → 成本 → id（末位保证确定性） */
function compareRank(a: AcceptedCandidate, b: AcceptedCandidate): number {
  return a.tier - b.tier ||
    a.policyPriority - b.policyPriority ||
    a.providerPriority - b.providerPriority ||
    a.estimatedCost - b.estimatedCost ||
    (a.providerId < b.providerId ? -1 : 1);
}

/** 审计用的 tier 不进入对外句柄（调用方只需 provider/模型/价格） */
function stripTier(c: AcceptedCandidate): RouteTarget {
  const target = { ...c } as RouteTarget & { tier?: number };
  delete target.tier;
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
  if (runnerUp && winner.estimatedCost < runnerUp.estimatedCost) return 'cost_optimal';
  return 'capability_match';
}

/** 被过滤候选是否“本可排在胜出者之前”（严格优于才算法定因素） */
function outranks(candidate: RoutingCandidateRecord, winner: AcceptedCandidate): boolean {
  const tier = candidate.allowListed ? 0 : 1;
  if (tier !== winner.tier) return tier < winner.tier;
  if (candidate.policyPriority !== winner.policyPriority) return candidate.policyPriority < winner.policyPriority;
  if (candidate.providerPriority !== winner.providerPriority) return candidate.providerPriority < winner.providerPriority;
  return (candidate.estimatedCost ?? 0) < winner.estimatedCost;
}
