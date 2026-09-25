import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/**
 * M8-P4 Analytics / BI（确定性聚合投影）：
 * - 只做「事实投影」：从事务表（UsageLedgerEntry / AgentRun / GenerationTask / UsageRecord /
 *   WorkflowRun）确定性聚合到 AnalyticsAggregate（period = YYYY-MM-DD 日粒度），
 *   metrics 只含事实数字 + 服务端算术（derived 在读时按 facts 重算）；
 * - 绝不含 LLM 解读：本模块不调用任何 LLM，也不接受 LLM 输出修改统计事实；
 * - 幂等刷新：同一 (organizationId, userId, kind, period, source) 重复刷新只更新不新增
 *   （先查后写；唯一键 P2002 兜底 update——并发刷新绝不产生第二行）；
 * - 组织归因与 M8-P2 计费一致（BillingService.organizationFor）：run.project.organizationId
 *   > run 无项目/项目无组织时的个人组织（isPersonal + ownerUserId）；
 * - 读路径（P2 性能包）：只读聚合表（query）+ **当日**补偿刷新（refreshToday：单日、幂等、
 *   17 查询上限），绝不按 range 内联刷新全区间——原实现 month=30×17、days=366≈6.2k 查询全在请求路径内。
 * - **历史聚合由显式刷新维护**：POST /analytics/refresh（refreshAll，≤366 天）或后台/运维任务；
 *   读请求只保证「今天」的数字实时（当日聚合随读写变化重算），历史日期的聚合行按刷新时点冻结。
 * - 写路径只在 refresh*（显式入口）；刷新原语 refreshOrganization/refreshAll 语义不变（幂等）。
 */

export type AnalyticsKind = 'usage' | 'agent' | 'generation' | 'provider' | 'workflow';

/** 事务来源标注（每行聚合可追溯到唯一事务表——审计/复算依据） */
export type AnalyticsSource = 'usage_ledger' | 'agent_run' | 'generation_task' | 'usage_record' | 'workflow_run';

export const ANALYTICS_KINDS: AnalyticsKind[] = ['usage', 'agent', 'generation', 'provider', 'workflow'];

export const KIND_SOURCE: Record<AnalyticsKind, AnalyticsSource> = {
  usage: 'usage_ledger',
  agent: 'agent_run',
  generation: 'generation_task',
  provider: 'usage_record',
  workflow: 'workflow_run',
};

export type AnalyticsRange = 'day' | 'week' | 'month';

/** 跨零点 run 的归因回看窗（run 创建于前一日、其调用发生在当日的兜底；有界，绝不全表扫描） */
const ATTRIBUTION_LOOKBACK_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

// ===== 日粒度工具（统一 UTC 边界：period 与窗口同源，绝无本地时区漂移）=====

export function periodOf(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function dayRange(period: string): { start: Date; end: Date } {
  const start = new Date(`${period}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new AppError(ErrorCode.VALIDATION_ERROR, `日期格式非法：${period}（期望 YYYY-MM-DD）`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export function addDays(period: string, delta: number): string {
  const { start } = dayRange(period);
  return periodOf(new Date(start.getTime() + delta * DAY_MS));
}

export function rangeOf(range: AnalyticsRange, today: Date = new Date()): { from: string; to: string; days: number } {
  const days = range === 'day' ? 1 : range === 'week' ? 7 : 30;
  const to = periodOf(today);
  return { from: addDays(to, -(days - 1)), to, days };
}

/** 聚合行指标合并（跨天/跨 kind 求和；嵌套对象递归合并，如 provider.byProvider） */
export function mergeMetrics(target: Record<string, unknown>, source: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries((source ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'number') out[key] = ((out[key] as number) ?? 0) + value;
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeMetrics((out[key] as Record<string, unknown>) ?? {}, value);
    } else out[key] = value;
  }
  return out;
}

/** 均值类指标绝不跨天求和：读路径按 totals/samples 重算（facts 仍是 totals 与 samples） */
export function finalizeMetrics(kind: string, metrics: Record<string, unknown>): Record<string, unknown> {
  const out = { ...metrics };
  const samples = out.durationSamples;
  if (kind === 'agent' && typeof samples === 'number' && samples > 0 && typeof out.durationMsTotal === 'number') {
    out.avgDurationMs = round(out.durationMsTotal / samples);
  }
  return out;
}

export function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface OrgAttribution {
  id: string;
  isPersonal: boolean;
  ownerUserId: string;
}

interface RunRow {
  id: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
}

interface Metrics {
  metrics: Record<string, unknown>;
  dimensions?: Record<string, unknown> | null;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger('Analytics');

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // ===== 组织归因 =====

  private async organization(organizationId: string): Promise<OrgAttribution | null> {
    return this.prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: { id: true, isPersonal: true, ownerUserId: true },
    });
  }

  /**
   * 组织归因子句（与 BillingService.organizationFor 同语义）：
   * project.organizationId = org；个人组织额外覆盖「无项目」与「项目无组织」的历史行。
   */
  private attributionClauses(org: OrgAttribution): Prisma.AgentRunWhereInput[] {
    const clauses: Prisma.AgentRunWhereInput[] = [{ project: { organizationId: org.id } }];
    if (org.isPersonal) {
      clauses.push({ userId: org.ownerUserId, projectId: null });
      clauses.push({ userId: org.ownerUserId, project: { organizationId: null } });
    }
    return clauses;
  }

  /** 窗口内归因到该组织的 AgentRun（含状态/时长；后续维度复用同一份归因结果） */
  private async attributedRuns(org: OrgAttribution, start: Date, end: Date): Promise<RunRow[]> {
    return this.prisma.agentRun.findMany({
      where: { createdAt: { gte: start, lt: end }, OR: this.attributionClauses(org) },
      select: { id: true, status: true, startedAt: true, completedAt: true },
    });
  }

  /**
   * 归因 helper（M8-P4 规格）：该组织在 [dayStart, dayEnd) 内创建的 AgentRun id 列表。
   * 归因规则：project.organizationId = org，或个人组织下 userId = owner 且无项目/项目无组织。
   */
  async runsOfOrganization(organizationId: string, dayStart: Date, dayEnd: Date): Promise<string[]> {
    const org = await this.organization(organizationId);
    if (!org) return [];
    const runs = await this.attributedRuns(org, dayStart, dayEnd);
    return runs.map((r) => r.id);
  }

  // ===== 刷新（写路径：确定性 + 幂等）=====

  /** 指定日期（缺省今日）全维度刷新；重复调用只更新不新增 */
  async refreshOrganization(
    organizationId: string,
    date: Date | string = new Date(),
  ): Promise<{ organizationId: string; period: string; kinds: AnalyticsKind[] }> {
    const period = typeof date === 'string' ? date : periodOf(date);
    const { start, end } = dayRange(period);
    const org = await this.organization(organizationId);
    if (!org) throw new AppError(ErrorCode.NOT_FOUND, '组织不存在');

    // agent 维度 = 当日创建的 run；generation/provider 归因用有界回看窗（跨零点 run 兜底）
    const dayRuns = await this.attributedRuns(org, start, end);
    const attribution = await this.attributedRuns(org, new Date(start.getTime() - ATTRIBUTION_LOOKBACK_MS), end);
    const runIds = attribution.map((r) => r.id);

    const [usage, agent, generation, provider, workflow] = await Promise.all([
      this.usageMetrics(organizationId, start, end),
      Promise.resolve(this.agentMetrics(dayRuns)),
      this.generationMetrics(org, start, end, runIds),
      this.providerMetrics(org, start, end, runIds),
      this.workflowMetrics(org, start, end),
    ]);

    const rows: Array<{ kind: AnalyticsKind }> = [
      { kind: 'usage' }, { kind: 'agent' }, { kind: 'generation' }, { kind: 'provider' }, { kind: 'workflow' },
    ];
    const payload: Record<AnalyticsKind, Metrics> = { usage, agent, generation, provider, workflow };
    for (const row of rows) {
      await this.upsertAggregate({
        organizationId,
        // Pre-M9 S1：'global' 显式哨兵（NOT NULL + 唯一约束生效——绝不 NULL 隐式全局）
        userId: 'global',
        kind: row.kind,
        period,
        source: KIND_SOURCE[row.kind],
        metrics: payload[row.kind].metrics,
        dimensions: payload[row.kind].dimensions ?? null,
      });
    }
    this.logger.debug({ organizationId, period, runs: dayRuns.length }, '分析聚合已刷新');
    return { organizationId, period, kinds: rows.map((r) => r.kind) };
  }

  /** 按天循环刷新 [from, to]（含端点；单日粒度幂等） */
  async refreshAll(
    organizationId: string,
    from: string,
    to: string,
  ): Promise<{ organizationId: string; from: string; to: string; days: number; periods: string[] }> {
    if (from > to) throw new AppError(ErrorCode.VALIDATION_ERROR, '起始日期不得晚于结束日期');
    const periods: string[] = [];
    for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
      if (periods.length >= 366) throw new AppError(ErrorCode.VALIDATION_ERROR, '刷新区间最长 366 天');
      periods.push(cursor);
    }
    for (const period of periods) await this.refreshOrganization(organizationId, period);
    return { organizationId, from, to, days: periods.length, periods };
  }

  /**
   * P2 轻量补偿刷新（读路径唯一允许的刷新）：只补刷**当日**——单日幂等、查询数有上界（17），
   * 与 range 无关。历史区间（week/month/自定义）只读已有聚合行，由显式刷新维护。
   * 绝不在请求路径内联 refreshAll（原 month=30×17、days=366≈6.2k 查询）。
   */
  private async refreshToday(organizationId: string): Promise<void> {
    await this.refreshOrganization(organizationId, periodOf(new Date()));
  }

  /**
   * 幂等写入（绝不重复统计）：同 (org, user, kind, period, source) 先查后写；
   * 并发下唯一键 P2002 → 兜底 update（唯一赢家建行，其余更新之）。
   */
  private async upsertAggregate(input: {
    organizationId: string;
    userId: string;
    kind: AnalyticsKind;
    period: string;
    source: AnalyticsSource;
    metrics: Record<string, unknown>;
    dimensions: Record<string, unknown> | null;
  }): Promise<{ id: string; created: boolean }> {
    const where = {
      organizationId: input.organizationId,
      userId: input.userId,
      kind: input.kind,
      period: input.period,
      source: input.source,
    };
    const data = {
      metrics: input.metrics as Prisma.InputJsonValue,
      dimensions: (input.dimensions ?? Prisma.DbNull) as Prisma.InputJsonValue,
      refreshedAt: new Date(),
    };
    const existing = await this.prisma.analyticsAggregate.findFirst({ where, select: { id: true } });
    if (existing) {
      await this.prisma.analyticsAggregate.update({ where: { id: existing.id }, data });
      return { id: existing.id, created: false };
    }
    try {
      const created = await this.prisma.analyticsAggregate.create({ data: { ...where, ...data } });
      return { id: created.id, created: true };
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      const won = await this.prisma.analyticsAggregate.findFirst({ where, select: { id: true } });
      if (!won) throw err;
      await this.prisma.analyticsAggregate.update({ where: { id: won.id }, data });
      return { id: won.id, created: false };
    }
  }

  // ===== 各维度聚合（纯函数式投影：只读事务行 → metrics）=====

  /** kind=usage / source=usage_ledger：组织计量归集（M8-P2 ledger，quantity 求和） */
  private async usageMetrics(organizationId: string, start: Date, end: Date): Promise<Metrics> {
    const rows = await this.prisma.usageLedgerEntry.findMany({
      where: { organizationId, createdAt: { gte: start, lt: end } },
      select: { kind: true, quantity: true, unit: true },
    });
    const metrics: Record<string, unknown> = {
      agent_run: 0, llm_tokens: 0, llm_cost: 0, image_generation: 0,
      video_seconds: 0, external_api_call: 0, workflow_run: 0,
    };
    for (const row of rows) metrics[row.kind] = num(metrics[row.kind]) + row.quantity;
    metrics.entries = rows.length;
    return { metrics, dimensions: null };
  }

  /** kind=agent / source=agent_run：状态分布 + 时长合计/样本（avg 由读路径重算） */
  private agentMetrics(runs: RunRow[]): Metrics {
    const metrics: Record<string, unknown> = {
      runs: runs.length, completed: 0, failed: 0, cancelled: 0, timeout: 0,
      queued: 0, running: 0, waiting: 0, durationMsTotal: 0, durationSamples: 0,
    };
    for (const run of runs) {
      if (run.status in metrics && typeof metrics[run.status] === 'number') metrics[run.status] = num(metrics[run.status]) + 1;
      if (run.completedAt) {
        const duration = run.completedAt.getTime() - run.startedAt.getTime();
        if (duration >= 0) {
          metrics.durationMsTotal = num(metrics.durationMsTotal) + duration;
          metrics.durationSamples = num(metrics.durationSamples) + 1;
        }
      }
    }
    if (num(metrics.durationSamples) > 0) metrics.avgDurationMs = round(num(metrics.durationMsTotal) / num(metrics.durationSamples));
    return { metrics, dimensions: null };
  }

  /** kind=generation / source=generation_task：image/video 成功失败数（按 run 归因；无 run 按个人组织） */
  private async generationMetrics(org: OrgAttribution, start: Date, end: Date, runIds: string[]): Promise<Metrics> {
    const clauses: Prisma.GenerationTaskWhereInput[] = [{ runId: { in: runIds } }];
    if (org.isPersonal) clauses.push({ runId: null, userId: org.ownerUserId });
    const rows = await this.prisma.generationTask.findMany({
      where: { createdAt: { gte: start, lt: end }, OR: clauses },
      select: { type: true, status: true, costEstimate: true },
    });
    const metrics: Record<string, unknown> = {
      tasks: rows.length, imageSucceeded: 0, imageFailed: 0, imageCancelled: 0,
      videoSucceeded: 0, videoFailed: 0, videoCancelled: 0, estimatedCost: 0,
    };
    for (const row of rows) {
      const type = row.type === 'image' ? 'image' : 'video';
      const bucket = row.status === 'completed' ? 'Succeeded' : row.status === 'failed' ? 'Failed' : 'Cancelled';
      const key = `${type}${bucket}`;
      if (key in metrics) metrics[key] = num(metrics[key]) + 1;
      metrics.estimatedCost = round(num(metrics.estimatedCost) + (row.costEstimate ?? 0));
    }
    return { metrics, dimensions: null };
  }

  /** kind=provider / source=usage_record：按 providerId 分组（调用次数/estimatedCost/失败数） */
  private async providerMetrics(org: OrgAttribution, start: Date, end: Date, runIds: string[]): Promise<Metrics> {
    const clauses: Prisma.UsageRecordWhereInput[] = [{ runId: { in: runIds } }];
    if (org.isPersonal) clauses.push({ runId: null, userId: org.ownerUserId });
    const rows = await this.prisma.usageRecord.findMany({
      where: { createdAt: { gte: start, lt: end }, OR: clauses },
      select: { providerId: true, estimatedCost: true, status: true, kind: true },
    });
    const byProvider: Record<string, { calls: number; estimatedCost: number; failed: number }> = {};
    let calls = 0;
    let estimatedCost = 0;
    let failed = 0;
    // Pre-M9 U1：按 kind 拆成本（llm_chat vs image/video）——overview 单源取数，绝不与账本相加双计
    let llmCost = 0;
    let mediaCost = 0;
    for (const row of rows) {
      const key = row.providerId ?? 'unknown';
      const bucket = byProvider[key] ?? { calls: 0, estimatedCost: 0, failed: 0 };
      bucket.calls += 1;
      bucket.estimatedCost = round(bucket.estimatedCost + row.estimatedCost);
      if (row.status === 'failed') bucket.failed += 1;
      byProvider[key] = bucket;
      calls += 1;
      estimatedCost = round(estimatedCost + row.estimatedCost);
      if (row.kind === 'llm_chat') llmCost = round(llmCost + row.estimatedCost);
      else mediaCost = round(mediaCost + row.estimatedCost);
      if (row.status === 'failed') failed += 1;
    }
    return {
      metrics: { calls, estimatedCost, failed, llmCost, mediaCost, providers: Object.keys(byProvider).length, byProvider },
      dimensions: { providers: Object.keys(byProvider).sort() },
    };
  }

  /** kind=workflow / source=workflow_run：workflow.organizationId 归因 → 总数 + 状态分布 */
  private async workflowMetrics(org: OrgAttribution, start: Date, end: Date): Promise<Metrics> {
    const clauses: Prisma.WorkflowRunWhereInput[] = [{ workflow: { organizationId: org.id } }];
    if (org.isPersonal) clauses.push({ userId: org.ownerUserId, workflow: { organizationId: null } });
    const rows = await this.prisma.workflowRun.findMany({
      where: { createdAt: { gte: start, lt: end }, OR: clauses },
      select: { status: true, triggerType: true },
    });
    const metrics: Record<string, unknown> = {
      runs: rows.length, completed: 0, failed: 0, cancelled: 0, timeout: 0, queued: 0, running: 0, waiting: 0,
    };
    const byTrigger: Record<string, number> = {};
    for (const row of rows) {
      if (row.status in metrics && typeof metrics[row.status] === 'number') metrics[row.status] = num(metrics[row.status]) + 1;
      byTrigger[row.triggerType] = (byTrigger[row.triggerType] ?? 0) + 1;
    }
    metrics.byTrigger = byTrigger;
    return { metrics, dimensions: null };
  }

  // ===== 读路径（只读聚合表）=====

  /** 聚合行读取 + 合并（series 为逐日事实；facts 为区间求和 + 均值重算） */
  async query(
    organizationId: string,
    options: { kind?: AnalyticsKind; from?: string; to?: string } = {},
  ): Promise<{
    organizationId: string;
    kind: AnalyticsKind | null;
    from: string;
    to: string;
    facts: Record<string, Record<string, unknown>>;
    series: Array<{ kind: string; period: string; metrics: Record<string, unknown>; dimensions: unknown; source: string }>;
    meta: { source: string[]; refreshedAt: Date | null; rows: number; layering: Record<string, string> };
  }> {
    const to = options.to ?? periodOf(new Date());
    const from = options.from ?? to;
    const rows = await this.prisma.analyticsAggregate.findMany({
      where: { organizationId, ...(options.kind ? { kind: options.kind } : {}), period: { gte: from, lte: to } },
      orderBy: [{ period: 'asc' }, { kind: 'asc' }],
      select: { kind: true, period: true, metrics: true, dimensions: true, source: true, refreshedAt: true },
    });
    const facts: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      facts[row.kind] = mergeMetrics(facts[row.kind] ?? {}, row.metrics);
    }
    for (const kind of Object.keys(facts)) facts[kind] = finalizeMetrics(kind, facts[kind]);
    const sources = [...new Set(rows.map((r) => r.source))].sort();
    const refreshedAt = rows.reduce<Date | null>((acc, r) => (acc === null || r.refreshedAt > acc ? r.refreshedAt : acc), null);
    return {
      organizationId, kind: options.kind ?? null, from, to,
      facts,
      series: rows.map((r) => ({
        kind: r.kind,
        period: r.period,
        metrics: r.metrics as Record<string, unknown>,
        dimensions: r.dimensions,
        source: r.source,
      })),
      meta: {
        source: sources,
        refreshedAt,
        rows: rows.length,
        layering: { facts: 'deterministic-projection', derived: 'service-computed' },
      },
    };
  }

  /** 跨 kind 汇总（facts 各维度 + derived 服务端计算，均标注分层） */
  async overview(organizationId: string, range: AnalyticsRange = 'day') {
    const { from, to, days } = rangeOf(range);
    // P2：出请求路径——只补刷当日（单日幂等），历史日期只读已有聚合行
    await this.refreshToday(organizationId);
    const result = await this.query(organizationId, { from, to });

    const usage = result.facts.usage ?? {};
    const agent = result.facts.agent ?? {};
    const generation = result.facts.generation ?? {};
    const provider = result.facts.provider ?? {};
    const workflow = result.facts.workflow ?? {};

    const runs = num(agent.runs);
    // Pre-M9 U1：成本单一事实源 = usage_records（provider 维度按 kind 拆分）；
    // 绝不 llmCost(账本) + providerCost(usage_records) 相加——账本 llm_cost 本身即 usage_records 投影，相加必双计。
    const llmCost = num(provider.llmCost);
    const mediaCost = num(provider.mediaCost);
    const providerCost = round(llmCost + mediaCost);
    const totalCost = providerCost;
    const members = await this.prisma.organizationMember.count({ where: { organizationId } });

    return {
      organizationId,
      range,
      from,
      to,
      days,
      facts: { usage, agent, generation, provider, workflow },
      context: { members },
      derived: {
        totalCost,
        llmCost: round(llmCost),
        providerCost: round(providerCost),
        runSuccessRate: runs > 0 ? round(num(agent.completed) / runs) : 0,
        avgRunDurationMs: num(agent.durationSamples) > 0 ? round(num(agent.durationMsTotal) / num(agent.durationSamples)) : 0,
        costPerRun: runs > 0 ? round(totalCost / runs) : 0,
        costPerMember: members > 0 ? round(totalCost / members) : 0,
        costPerDay: days > 0 ? round(totalCost / days) : 0,
        runsPerDay: days > 0 ? round(runs / days) : 0,
        imagesPerDay: days > 0 ? round(num(generation.imageSucceeded) / days) : 0,
        workflowSuccessRate: num(workflow.runs) > 0 ? round(num(workflow.completed) / num(workflow.runs)) : 0,
      },
      meta: {
        source: result.meta.source,
        refreshedAt: result.meta.refreshedAt,
        rows: result.meta.rows,
        layering: { facts: 'deterministic-projection', derived: 'service-computed', interpretation: 'none' },
      },
    };
  }

  /** 按天序列（facts 逐日；P2：与 overview 同一「只补刷当日」语义，历史日只读聚合行） */
  async breakdown(organizationId: string, options: { kind?: AnalyticsKind; days?: number } = {}) {
    const days = Math.min(Math.max(Math.trunc(options.days ?? 30), 1), 366);
    const to = periodOf(new Date());
    const from = addDays(to, -(days - 1));
    await this.refreshToday(organizationId);
    const result = await this.query(organizationId, { kind: options.kind, from, to });
    return {
      organizationId,
      kind: options.kind ?? null,
      from,
      to,
      days,
      series: result.series,
      facts: result.facts,
      meta: result.meta,
    };
  }

  /** 聚合行 source 追溯（哪一行来自哪张事务表；含 kind → source 映射） */
  async sources(organizationId: string, period?: string) {
    const target = period ?? periodOf(new Date());
    const rows = await this.prisma.analyticsAggregate.findMany({
      where: { organizationId, period: target },
      orderBy: [{ kind: 'asc' }, { source: 'asc' }],
      select: { kind: true, source: true, period: true, userId: true, dimensions: true, metrics: true, refreshedAt: true },
    });
    return {
      organizationId,
      period: target,
      kindSourceMap: KIND_SOURCE,
      count: rows.length,
      sources: rows.map((row) => ({
        kind: row.kind,
        source: row.source,
        period: row.period,
        scope: row.userId === 'global' ? 'organization' : 'user',
        metricKeys: Object.keys((row.metrics ?? {}) as Record<string, unknown>).sort(),
        dimensions: row.dimensions,
        refreshedAt: row.refreshedAt,
      })),
      layering: { facts: 'deterministic-projection', derived: 'service-computed', interpretation: 'none' },
    };
  }
}
