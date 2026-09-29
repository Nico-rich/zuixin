/**
 * M9-P5 洞察规则层（**纯函数，无 IO、无 LLM**）——facts / derived 一律服务端计算。
 *
 * 分层不变量（与 M7-P5 CommerceAnalysis 同一口径）：
 * - facts：回流原始事实的聚合（曝光/点击/花费/转化/营收/订单、评分计数）——**只由本文件求和**；
 * - derived：服务端按公式派生（ctr/cvr/roas/cpc、评分均值、环比变化）——**绝不含 LLM 文本**；
 * - interpretation：LLM 解读，独立字段与独立写入路径（见 insight.service 的 attachInterpretation），
 *   **绝不改写 facts/derived**（`factsHashOf` 指纹 + 保存前断言双保险）。
 *
 * 口径交叉引用（绝不新建第二套事实系统）：
 * - ctr/cvr/roas/cpc 公式与 M7-P8 `FeedbackService.derive` 完全一致（该实现为私有方法，故此处复算同一公式：
 *   比率 = 分子/分母，分母为 0 → 0，保留两位小数）；
 * - 评分好/差阈值与 M7-P8 一致（>=4 好、<=2 差）；
 * - 评测分数聚合**不在此处实现**——一律复用 M9-P1 `score-aggregation.summarizeScores`（单一事实源）。
 */

import { createHash } from 'node:crypto';
import { AppError, ErrorCode } from '../../common/errors/app-error';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 回流原始事实（CreativePerformance 的 facts 列） */
export interface PerfFacts {
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  revenue: number;
  orders: number;
}

export const EMPTY_PERF_FACTS: PerfFacts = {
  impressions: 0, clicks: 0, spend: 0, conversions: 0, revenue: 0, orders: 0,
};

export function sumPerfFacts(rows: readonly Partial<PerfFacts>[]): PerfFacts {
  const out: PerfFacts = { ...EMPTY_PERF_FACTS };
  for (const r of rows) {
    out.impressions += Number(r.impressions ?? 0) || 0;
    out.clicks += Number(r.clicks ?? 0) || 0;
    out.spend += Number(r.spend ?? 0) || 0;
    out.conversions += Number(r.conversions ?? 0) || 0;
    out.revenue += Number(r.revenue ?? 0) || 0;
    out.orders += Number(r.orders ?? 0) || 0;
  }
  out.spend = round2(out.spend);
  out.revenue = round2(out.revenue);
  return out;
}

/** 服务端派生指标（facts 输入 → derived 输出；分母为 0 → 0） */
export function derivePerfMetrics(facts: PerfFacts): { ctr: number; cvr: number; roas: number; cpc: number } {
  return {
    ctr: facts.impressions > 0 ? round2(facts.clicks / facts.impressions) : 0,
    cvr: facts.clicks > 0 ? round2(facts.conversions / facts.clicks) : 0,
    roas: facts.spend > 0 ? round2(facts.revenue / facts.spend) : 0,
    cpc: facts.clicks > 0 ? round2(facts.spend / facts.clicks) : 0,
  };
}

/**
 * 评分好/差阈值（与 M7-P8 口径一致：>=4 好、<=2 差）。
 * M12-P4：可由 `SystemSetting('policyThresholds').insight` 覆盖（运营者调档，仅平台管理员可写）；
 * 本常量仍是**最后一跳兜底**（缺省行为逐字节不变）——本文件保持纯函数，阈值由调用方显式传入。
 */
export const RATING_GOOD = 4;
export const RATING_BAD = 2;

/** 洞察阈值（缺省 = 编译期常量口径） */
export interface InsightThresholds {
  ratingGood: number;
  ratingBad: number;
  comparisonPct: number;
}

export const DEFAULT_INSIGHT_THRESHOLDS: InsightThresholds = {
  ratingGood: RATING_GOOD,
  ratingBad: RATING_BAD,
  comparisonPct: 10, // = COMPARISON_THRESHOLD_PCT（同文件下方定义；此处字面量避免自引用，由单测锁死一致）
};

export interface RatingFacts {
  count: number;
  avgRating: number;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  /** 好评率（rating >= 4） */
  positiveRate: number;
  /** 差评率（rating <= 2） */
  negativeRate: number;
}

export function summarizeRatings(
  ratings: readonly number[],
  thresholds: Pick<InsightThresholds, 'ratingGood' | 'ratingBad'> = DEFAULT_INSIGHT_THRESHOLDS,
): RatingFacts {
  const distribution: RatingFacts['distribution'] = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let sum = 0;
  let positive = 0;
  let negative = 0;
  for (const rating of ratings) {
    const r = Math.round(Number(rating));
    if (!Number.isFinite(r) || r < 1 || r > 5) continue;
    distribution[String(r) as keyof RatingFacts['distribution']] += 1;
    sum += r;
    if (r >= thresholds.ratingGood) positive += 1;
    if (r <= thresholds.ratingBad) negative += 1;
  }
  const count = Object.values(distribution).reduce((a, b) => a + b, 0);
  return {
    count,
    avgRating: count > 0 ? round2(sum / count) : 0,
    distribution,
    positiveRate: count > 0 ? round2(positive / count) : 0,
    negativeRate: count > 0 ? round2(negative / count) : 0,
  };
}

/**
 * 环比变化阈值（与 M7-P5 异常检测同口径：10%）。
 * M12-P4：可由 `SystemSetting('policyThresholds').insight.comparisonPct` 覆盖（**调用方显式传参**；
 * `comparePeriods` 的第三参数即该阈值——本文件保持纯函数，绝不自行读配置）。
 */
export const COMPARISON_THRESHOLD_PCT = 10;

export interface ComparisonEntry {
  metric: string;
  base: number;
  compare: number;
  changePct: number;
  direction: 'up' | 'down' | 'flat';
  /** 是否越过阈值（服务端规则判定，供上层标注 anomaly/提升） */
  beyondThreshold: boolean;
  rule: 'server-comparison';
}

/**
 * 环比对比（当期 vs 前一期，**双向**：上升与下降都记录）。
 * 与 M7-P5 `detectAnomalies` 的关系：后者只记录"下降 ≥ 阈值"的异常（决策告警视角）；
 * 本函数是**超集**（双向 + 全指标），供洞察层做"绩效指标对比"事实，绝不反向改写 M7-P5 规则。
 * 前一期为 0（无可比基线）→ 跳过该指标（绝不臆造 ∞/100% 变化）。
 */
export function comparePeriods(
  current: Record<string, number>,
  previous: Record<string, number>,
  metrics: readonly string[],
  thresholdPct: number = COMPARISON_THRESHOLD_PCT,
): ComparisonEntry[] {
  const out: ComparisonEntry[] = [];
  for (const metric of metrics) {
    const cur = Number(current[metric]);
    const prev = Number(previous[metric]);
    if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) continue;
    const changePct = round2(((cur - prev) / prev) * 100);
    out.push({
      metric,
      base: prev,
      compare: cur,
      changePct,
      direction: changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat',
      beyondThreshold: Math.abs(changePct) >= thresholdPct,
      rule: 'server-comparison',
    });
  }
  return out;
}

/** 达标判据（假设创建时声明；服务端按事实判定，绝不信客户端结论） */
export interface SuccessCriteria {
  metric: 'avg_score' | 'pass_rate' | 'roas' | 'ctr';
  op: 'gte' | 'lte';
  value: number;
}

export const SUCCESS_CRITERIA_METRICS: readonly SuccessCriteria['metric'][] = ['avg_score', 'pass_rate', 'roas', 'ctr'];

/**
 * 判据指标 → 事实来源（M12-P1 来源判别的影响面）：
 * `roas`/`ctr` 来自 `CreativePerformance`（**agent 可经 performance.capture 写**）→ 受来源谓词约束；
 * `avg_score`/`pass_rate` 来自 M9-P1 评测摘要（agent 无写工具面）→ 不受绩效来源谓词影响。
 */
export const PERF_DERIVED_CRITERIA_METRICS: readonly SuccessCriteria['metric'][] = ['roas', 'ctr'];

/** 该判据指标是否取自绩效回流事实（受来源判别约束） */
export function isPerfDerivedMetric(metric: SuccessCriteria['metric']): boolean {
  return PERF_DERIVED_CRITERIA_METRICS.includes(metric);
}

export function isCriteriaSatisfied(
  criteria: SuccessCriteria,
  facts: Readonly<Record<string, number | null | undefined>>,
): { satisfiable: boolean; satisfied: boolean; actual: number | null; reason: string } {
  const raw = facts[criteria.metric];
  const actual = raw == null || !Number.isFinite(Number(raw)) ? null : Number(raw);
  if (actual === null) {
    return { satisfiable: false, satisfied: false, actual: null, reason: `事实缺失（${criteria.metric}），无法按判据判定` };
  }
  const satisfied = criteria.op === 'gte' ? actual >= criteria.value : actual <= criteria.value;
  return {
    satisfiable: true,
    satisfied,
    actual,
    reason: `${criteria.metric}=${actual} ${criteria.op === 'gte' ? '≥' : '≤'} ${criteria.value} → ${satisfied ? '成立' : '不成立'}`,
  };
}

// ===== M12-P1 来源判别（审计 R1：agent 可写工具绝不自证假设）=====

/**
 * agent 可写绩效工具名（`performance.capture`，M7-P8）。它是**唯一**能写 `CreativePerformance` 的
 * 工具路径（HTTP 路径 `POST /feedback/performance` 需用户 JWT，非 agent 工具面）。
 *
 * 为什么需要这条谓词：绩效回流行一旦被计入判定窗口，agent 就能用工具**伪造绩效自证自己的假设**
 * （闭环判定不得被一个可写副作用的工具所操纵）。`CreativePerformance` 在冻结 schema 下**没有来源列**
 * （不新增迁移的红线优先），故来源信号只能取**既有 ToolCall 幂等账本**：
 * agent 工具路径一律经 `withToolCallLedger(prisma, ctx.toolCallId, …)` 写入，
 * 该事务把工具返回值（含 `performanceId`）**与副作用行同时提交**到 `ToolCall.output`。
 */
export const AGENT_PERFORMANCE_TOOL = 'performance.capture';

/**
 * 从 ToolCall 账本载荷（= 工具返回值）中提取"由 agent 工具写入"的绩效行 id（纯函数）。
 * 账本载荷形状 = `performance.capture` 的返回 `{ performanceId, facts, derived, layering }`；
 * 非该形状（缺 `performanceId`/类型不符）一律忽略——绝不把无关账本读成绩效来源。
 */
export function agentPerformanceIds(ledgerOutputs: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const output of ledgerOutputs) {
    const candidate = (output ?? null) as { performanceId?: unknown } | null;
    const id = candidate && typeof candidate === 'object' ? candidate.performanceId : undefined;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return ids;
}

/**
 * 事实窗口过滤：**排除 agent 来源的绩效行**（纯函数——判定/洞察的事实层只计入非 agent 来源）。
 * 返回保留行与排除计数：计数必须随事实一并留痕（**绝不静默丢弃事实**，排除本身也是可审计事实）。
 */
export function excludeAgentPerformance<T extends { id: string }>(
  rows: readonly T[],
  agentAuthoredIds: ReadonlySet<string>,
): { rows: T[]; excludedAgentRows: number } {
  const kept = rows.filter((row) => !agentAuthoredIds.has(row.id));
  return { rows: kept, excludedAgentRows: rows.length - kept.length };
}

/** 稳定序列化（键排序；绝不受对象键插入顺序影响——facts 指纹的可复现前提） */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * facts 指纹（facts + derived 的稳定摘要）——"解读绝不改写事实"的可验证锚点：
 * 解读写入前必须匹配同一指纹（条件更新），指纹不一致 → 拒写（事实已变，解读必须基于最新事实重写）。
 */
export function factsHashOf(facts: unknown, derived: unknown): string {
  return createHash('sha256').update(stableStringify({ facts, derived })).digest('hex');
}

/** 事实层键（解读写入路径**绝不**触碰这些键——由单测与 e2e 双重锁死） */
export const FACT_LAYER_KEYS = ['facts', 'derived'] as const;

/** 断言：解读写入前后事实层逐字节不变（违反 → INTERNAL，绝不静默放行） */
export function assertFactsUnchanged(
  before: { facts?: unknown; derived?: unknown },
  after: { facts?: unknown; derived?: unknown },
): void {
  for (const key of FACT_LAYER_KEYS) {
    if (stableStringify(before[key]) !== stableStringify(after[key])) {
      throw new AppError(ErrorCode.INTERNAL, `洞察事实层被解读改写: ${key}（不变量被破坏，拒绝写入）`);
    }
  }
}
