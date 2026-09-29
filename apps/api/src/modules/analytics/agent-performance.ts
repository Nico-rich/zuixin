import type { Prisma } from '@prisma/client';
import { addDays, periodOf, round } from './analytics-primitives';

/**
 * M12-P2 Agent 表现回流（**纯查询投影 + 只影响顺序**）：
 *
 * - 数据来源 = AnalyticsAggregate(kind=agent) 行内 `metrics.byAgent` 维度（M12-P2 起刷新时按 agentId 投影）
 *   ——**不建任何汇总表**、不写入、不触发刷新、不读 UsageRecord（计费事实源与表现无关）；
 * - 有界：窗口 ≤ MAX_PERFORMANCE_WINDOW_DAYS 天 + 单次读取行数上限（take）——绝不全表扫描；
 * - 只描述「已发生事实」：计数 + 时长合计/样本，派生量（终态数/成功率/失败率/均值）在读时按 facts 重算，
 *   绝不跨天求"平均的平均"；
 * - 消费方（agent-registry / delegation）只用它做**候选顺序**的稳定性打破：候选集合、工具集、权限、模型
 *   一律不由表现数据决定（红线：LLM 不下发模型/路由选择权，表现数据同样不下发选择权，只调顺序）；
 * - 数据缺失（无聚合行 / 样本不足 / 读取失败）→ 调用方回退静态顺序（零行为漂移）。
 */

/** 表现窗口默认 14 天（近期表现；与 provider 健康排序同为"当前可用性"口径） */
export const DEFAULT_PERFORMANCE_WINDOW_DAYS = 14;
/** 表现窗口上限 90 天（有界：绝不无界回看） */
export const MAX_PERFORMANCE_WINDOW_DAYS = 90;
/** 参与排序所需的最小**终态**样本数（样本不足视为"无表现数据"，绝不按 1 次抖动改序） */
export const DEFAULT_PERFORMANCE_MIN_SAMPLES = 5;
/** 单次读取聚合行上限（平台级跨组织读取的护栏；按 period 倒序取最近的行） */
export const MAX_PERFORMANCE_ROWS = 5000;

/** 逐日累加的事实键（byAgent 维度与顶层 agent 维度同构） */
const AGENT_FACT_KEYS = [
  'runs', 'completed', 'failed', 'cancelled', 'timeout', 'queued', 'running', 'waiting',
  'durationMsTotal', 'durationSamples',
] as const;

/** 事实 + 读时派生（terminal/successRate/failureRate/avgDurationMs 均为服务端算术，绝不来自 LLM） */
export interface AgentPerfFacts {
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  timeout: number;
  queued: number;
  running: number;
  waiting: number;
  durationMsTotal: number;
  durationSamples: number;
  /** 终态 run 数 = completed + failed + cancelled + timeout（成功率/失败率的分母） */
  terminal: number;
  /** completed / terminal（终态口径；在途 queued/running 不进分母；无终态样本 → 0） */
  successRate: number;
  /** failed / terminal（同上口径） */
  failureRate: number;
  /** 有终态且有时长样本时的平均时长；否则 0 */
  avgDurationMs: number;
}

export interface AgentPerformanceStat extends AgentPerfFacts {
  agentId: string;
}

export type AgentPerformanceRow = { period: string; metrics: unknown };

/** 聚合行读取所需的最小 Prisma 面（纯读；PrismaService / TransactionClient 均满足） */
export type AgentPerformanceReader = Pick<Prisma.TransactionClient, 'analyticsAggregate'>;

export interface LoadAgentPerformanceOptions {
  /** 缺省 = 平台级（所有组织求和）；仅供内部排序输入，绝不挂 HTTP 面 */
  organizationId?: string;
  /** 窗口天数（缺省 14；越界自动夹取到 [1, 90]） */
  days?: number;
  /** 窗口右端（缺省今天 UTC；测试可注入固定时刻） */
  now?: Date;
  /** 读取行数上限（缺省 MAX_PERFORMANCE_ROWS） */
  maxRows?: number;
}

/** 表现排序配置（systemSetting.routingPolicy.performanceRanking；非法值忽略回默认） */
export interface PerformanceRankingConfig {
  windowDays?: number;
  minSamples?: number;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 窗口夹取：[1, MAX_PERFORMANCE_WINDOW_DAYS] */
export function normalizePerformanceWindowDays(days?: number): number {
  const raw = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.trunc(Number(days)) : DEFAULT_PERFORMANCE_WINDOW_DAYS;
  return Math.min(Math.max(raw, 1), MAX_PERFORMANCE_WINDOW_DAYS);
}

/** 最小样本数夹取：非有限/负数 → 默认；0 = 允许 1 次样本参与排序（运维显式放开） */
export function normalizeMinSamples(minSamples?: number): number {
  if (minSamples === undefined || minSamples === null) return DEFAULT_PERFORMANCE_MIN_SAMPLES;
  const raw = Number(minSamples);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_PERFORMANCE_MIN_SAMPLES;
  return Math.trunc(raw);
}

/** 解析 routingPolicy.performanceRanking（非法配置一律忽略回默认，绝不因此抛错） */
export function parsePerformanceRanking(value: unknown): PerformanceRankingConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: PerformanceRankingConfig = {};
  if (raw.windowDays !== undefined && Number.isFinite(Number(raw.windowDays)) && Number(raw.windowDays) > 0) {
    out.windowDays = Math.trunc(Number(raw.windowDays));
  }
  if (raw.minSamples !== undefined && Number.isFinite(Number(raw.minSamples)) && Number(raw.minSamples) >= 0) {
    out.minSamples = Math.trunc(Number(raw.minSamples));
  }
  return out;
}

/**
 * 单 agent 事实累加（跨天/跨组织合并：数字相加）。
 * 非对象（null/数组/标量）→ 原样返回（绝不因脏 JSON 抛错）。
 */
export function accumulateAgentFacts(target: Record<string, number>, raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return target;
  const src = raw as Record<string, unknown>;
  for (const key of AGENT_FACT_KEYS) {
    const value = src[key];
    if (typeof value === 'number' && Number.isFinite(value)) target[key] = num(target[key]) + value;
  }
  return target;
}

/** 读时派生（facts → 终态数/成功率/失败率/平均时长）：绝不跨天求平均的平均 */
export function finalizeAgentFacts(raw: unknown): AgentPerfFacts {
  const facts: AgentPerfFacts = {
    runs: 0, completed: 0, failed: 0, cancelled: 0, timeout: 0,
    queued: 0, running: 0, waiting: 0, durationMsTotal: 0, durationSamples: 0,
    terminal: 0, successRate: 0, failureRate: 0, avgDurationMs: 0,
  };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const src = raw as Record<string, unknown>;
    for (const key of AGENT_FACT_KEYS) facts[key] = num(src[key]);
  }
  facts.terminal = facts.completed + facts.failed + facts.cancelled + facts.timeout;
  if (facts.terminal > 0) {
    facts.successRate = round(facts.completed / facts.terminal);
    facts.failureRate = round(facts.failed / facts.terminal);
  }
  if (facts.durationSamples > 0) facts.avgDurationMs = round(facts.durationMsTotal / facts.durationSamples);
  return facts;
}

/**
 * 聚合行 → 按 agentId 的表现统计（纯函数；跨行/跨组织求和后一次性派生）。
 * 只认 `metrics.byAgent`（M12-P2 起的投影维度）；历史行（无该维度）不贡献任何 agent 样本
 * ——宁可"无数据回退静态顺序"，也绝不用无法归因的数字凑样本。
 */
export function summarizeAgentAggregateRows(rows: readonly AgentPerformanceRow[]): AgentPerformanceStat[] {
  const byAgent = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const metrics = row?.metrics;
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) continue;
    const perAgent = (metrics as Record<string, unknown>).byAgent;
    if (!perAgent || typeof perAgent !== 'object' || Array.isArray(perAgent)) continue;
    for (const [agentId, facts] of Object.entries(perAgent as Record<string, unknown>)) {
      if (!agentId) continue;
      byAgent.set(agentId, accumulateAgentFacts(byAgent.get(agentId) ?? {}, facts));
    }
  }
  return [...byAgent.entries()]
    .map(([agentId, facts]) => ({ agentId, ...finalizeAgentFacts(facts) }))
    .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)); // 确定性输出顺序
}

/** 窗口 [from, to]（UTC 日边界，含端点）——与聚合 period 同源 */
export function performanceWindow(days?: number, now: Date = new Date()): { from: string; to: string; days: number } {
  const windowDays = normalizePerformanceWindowDays(days);
  const to = periodOf(now);
  return { from: addDays(to, -(windowDays - 1)), to, days: windowDays };
}

/**
 * 读取近期 Agent 表现（纯查询投影：单次有界 findMany，绝不写入/刷新）。
 * 读取失败由调用方决定降级策略（本函数不吞错——静默吞错会掩盖 DB 故障）。
 */
export async function loadAgentPerformance(
  prisma: AgentPerformanceReader,
  options: LoadAgentPerformanceOptions = {},
): Promise<AgentPerformanceStat[]> {
  const { from, to } = performanceWindow(options.days, options.now ?? new Date());
  const maxRows = Number.isFinite(Number(options.maxRows)) && Number(options.maxRows) > 0
    ? Math.trunc(Number(options.maxRows))
    : MAX_PERFORMANCE_ROWS;
  const rows = await prisma.analyticsAggregate.findMany({
    where: {
      kind: 'agent',
      period: { gte: from, lte: to },
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
    },
    select: { period: true, metrics: true },
    orderBy: [{ period: 'desc' }], // 超上限时保留最近的行（绝不因截断引入更早的陈旧样本）
    take: maxRows,
  });
  return summarizeAgentAggregateRows(rows as readonly AgentPerformanceRow[]);
}

/** agentId → 统计（排序输入索引） */
export function performanceIndex(stats: readonly AgentPerformanceStat[]): Map<string, AgentPerformanceStat> {
  return new Map(stats.map((s) => [s.agentId, s]));
}

export interface RankByAgentPerformanceOptions<T> {
  /** 候选 → 表现键（= AgentRun.agentId，即 Agent 主键 id） */
  agentId: (candidate: T) => string;
  stats: readonly AgentPerformanceStat[];
  /** 最小终态样本数（缺省 5；低于该值的候选视为"无表现数据"） */
  minSamples?: number;
}

/**
 * 候选按表现排序（**只改顺序，绝不增删候选**）：
 *
 * - 只有「样本充足」的候选参与重排，且**只在它们原本占据的位置之间**重排——
 *   无数据/样本不足的候选原地不动（冷启动 agent 不会被挤到队尾而永无翻身机会；
 *   数据缺失时输出 = 输入，零行为漂移）；
 * - 排序键：失败率升序 → 平均时长升序 → 静态序（稳定、确定性，绝不随机抖动）；
 * - 权限语义无关：函数只做顺序排列，候选集合/工具集/模型一律不在本层决定。
 */
export function rankByAgentPerformance<T>(candidates: readonly T[], options: RankByAgentPerformanceOptions<T>): T[] {
  const minSamples = normalizeMinSamples(options.minSamples);
  const index = performanceIndex(options.stats);
  const withData = candidates
    .map((candidate, position) => ({ candidate, position, stat: index.get(options.agentId(candidate)) }))
    .filter((entry): entry is { candidate: T; position: number; stat: AgentPerformanceStat } =>
      !!entry.stat && entry.stat.terminal >= minSamples);
  if (withData.length < 2) return [...candidates]; // 无数据 / 仅 1 个样本充足 → 静态顺序

  const slots = withData.map((e) => e.position); // 静态序下这些候选占用的位置
  const ranked = [...withData].sort((a, b) =>
    a.stat.failureRate - b.stat.failureRate
    || a.stat.avgDurationMs - b.stat.avgDurationMs
    || a.position - b.position);
  const out = [...candidates];
  slots.forEach((slot, i) => { out[slot] = ranked[i].candidate; });
  return out;
}
