/**
 * M9-P3 健康/延迟评分（纯函数，可单测）：
 * 路由排序的**服务端事实**输入——全部来自既有只读事实，不新建事实表：
 * - `Provider.healthStatus`（运营者/健康探测写入的权威状态）；
 * - 熔断窗口计数（CircuitBreakerService KV 窗口内的 consecutiveFailures / success）；
 * - 最近调用延迟采样（usage_records.latencyMs 聚合——真实计费事实，非本地估算）。
 *
 * 分数越高越优；**只影响排序，不做过滤**（过滤是 healthStatus=unhealthy / 熔断 open 的职责）。
 * 评分必须确定性：同样的输入 → 同样的分数 → 同样的排序（审计可复现）。
 */
import { HealthStatus } from '@prisma/client';

/**
 * M12-P4：评分参数可由 `SystemSetting('policyThresholds').providerHealth` 覆盖（运营者调档）；
 * 下列编译期常量是**最后一跳兜底**（缺省行为逐字节不变——单测锁死两处口径一致）。
 * 覆盖只影响**排序**（分数高低），绝不改变准入门槛：健康过滤/熔断过滤仍由 healthStatus 与熔断器独立裁决。
 */
export interface HealthScoring {
  baseScores?: Partial<Record<HealthStatus, number>>;
  failurePenaltyMax?: number;
  failureRateMinSamples?: number;
  latencyPenaltyMax?: number;
  latencyPenaltyFullMs?: number;
  latencyNeutralPenalty?: number;
}

/** 健康状态基分（unhealthy 在准入阶段已被剔除，此处兜底 0 分） */
export const HEALTH_BASE_SCORE: Record<HealthStatus, number> = {
  healthy: 100,
  untested: 80,
  unhealthy: 0,
};

/** 失败率罚分上限（失败率 = failures / (failures + successes)，百分比线性折算） */
export const FAILURE_PENALTY_MAX = 60;
/**
 * 失败率罚分的最小样本量：窗口内观测总数（失败+成功）低于该值 → 视为「证据不足」，罚分 0。
 * 单次历史失败（一次真实故障/一次重试耗尽）不足以把候选压到最低序（噪声主导排序），
 * 而「最近确实反复失败」（≥3 次观测且失败率高）才是排序该体现的事实。
 * 注意：这是**排序**的平滑，不是过滤——失败阈值/熔断 open 由熔断器与 healthStatus 独立裁决。
 */
export const FAILURE_RATE_MIN_SAMPLES = 3;
/** 延迟罚分上限 */
export const LATENCY_PENALTY_MAX = 30;
/** 平均延迟达到该值 → 延迟罚分拉满 */
export const LATENCY_PENALTY_FULL_MS = 30_000;
/** 无延迟样本时的中性分（既不奖励也不惩罚——绝不臆造延迟事实） */
export const LATENCY_NEUTRAL_PENALTY = LATENCY_PENALTY_MAX / 2;

export interface HealthFacts {
  healthStatus: HealthStatus | string;
  /** 熔断窗口内失败次数（KV 窗口，只读） */
  windowFailures: number;
  /** 熔断窗口内成功次数（KV 窗口，只读） */
  windowSuccesses: number;
  /** 最近平均延迟（ms）；null = 无样本 */
  latencyMs: number | null;
}

/** 窗口内失败率（0~1）；无样本 = 0（不臆造失败） */
export function failureRate(facts: Pick<HealthFacts, 'windowFailures' | 'windowSuccesses'>): number {
  const total = Math.max(0, facts.windowFailures) + Math.max(0, facts.windowSuccesses);
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, facts.windowFailures) / total);
}

/** 延迟罚分：线性折算并有上限；无样本 → 中性分 */
export function latencyPenalty(latencyMs: number | null, scoring: HealthScoring = {}): number {
  const max = scoring.latencyPenaltyMax ?? LATENCY_PENALTY_MAX;
  const fullMs = scoring.latencyPenaltyFullMs ?? LATENCY_PENALTY_FULL_MS;
  const neutral = scoring.latencyNeutralPenalty ?? (scoring.latencyPenaltyMax != null ? max / 2 : LATENCY_NEUTRAL_PENALTY);
  if (latencyMs == null || !Number.isFinite(latencyMs) || latencyMs < 0) return neutral;
  return Math.min(max, (latencyMs / fullMs) * max);
}

/** 窗口观测总数（失败 + 成功；脏事实按 0 计） */
export function sampleSize(facts: Pick<HealthFacts, 'windowFailures' | 'windowSuccesses'>): number {
  return Math.max(0, facts.windowFailures) + Math.max(0, facts.windowSuccesses);
}

/** 健康分（0~100，保留 4 位小数避免浮点噪声影响确定性排序）；`scoring` 缺省 = 编译期常量口径 */
export function healthScore(facts: HealthFacts, scoring: HealthScoring = {}): number {
  const base = scoring.baseScores?.[facts.healthStatus as HealthStatus] ?? HEALTH_BASE_SCORE[facts.healthStatus as HealthStatus] ?? HEALTH_BASE_SCORE.untested;
  const minSamples = scoring.failureRateMinSamples ?? FAILURE_RATE_MIN_SAMPLES;
  const penaltyMax = scoring.failurePenaltyMax ?? FAILURE_PENALTY_MAX;
  const failurePenalty = sampleSize(facts) >= minSamples
    ? failureRate(facts) * penaltyMax
    : 0; // 证据不足（<3 次观测）→ 不因单次历史失败改变排序
  const score = base - failurePenalty - latencyPenalty(facts.latencyMs, scoring);
  return Math.round(Math.max(0, Math.min(100, score)) * 1e4) / 1e4;
}

/**
 * 稳定哈希（FNV-1a 32 位）：stickyKey + providerId → 确定性分摊序。
 * 仅用于**完全同质**候选的 tie-break（同 capability/优先级/健康/价格/延迟）——
 * 同键恒定同序（可复现），不同键稳定打散（同质 provider 负载分摊）。
 */
export function stableHash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
