import { describe, expect, it } from 'vitest';
import { HealthStatus } from '@prisma/client';
import {
  FAILURE_PENALTY_MAX, FAILURE_RATE_MIN_SAMPLES, HEALTH_BASE_SCORE, LATENCY_NEUTRAL_PENALTY, LATENCY_PENALTY_FULL_MS,
  LATENCY_PENALTY_MAX, failureRate, healthScore, latencyPenalty, sampleSize, stableHash,
} from './health-score';

/**
 * M9-P3 健康/延迟评分（纯函数）：路由排序的只读事实输入——
 * Provider.healthStatus 基分 - 熔断窗口失败率罚分 - usage_records 延迟均值罚分。
 * 只影响排序、不做过滤；不打分臆造事实（无样本 → 中性分）。
 */
describe('M9-P3 health-score（只读事实评分）', () => {
  it('基分：healthy > untested > unhealthy；无瑕疵 healthy = 100', () => {
    expect(HEALTH_BASE_SCORE.healthy).toBeGreaterThan(HEALTH_BASE_SCORE.untested);
    expect(HEALTH_BASE_SCORE.untested).toBeGreaterThan(HEALTH_BASE_SCORE.unhealthy);
    expect(healthScore({ healthStatus: HealthStatus.healthy, windowFailures: 0, windowSuccesses: 0, latencyMs: 0 })).toBe(100);
  });

  it('无延迟样本 → 中性罚分（绝不臆造延迟事实）', () => {
    expect(latencyPenalty(null)).toBe(LATENCY_NEUTRAL_PENALTY);
    expect(healthScore({ healthStatus: HealthStatus.healthy, windowFailures: 0, windowSuccesses: 0, latencyMs: null })).toBe(85);
  });

  it('延迟罚分线性（30s 拉满）且非法事实退化为中性', () => {
    expect(latencyPenalty(1000)).toBeCloseTo(1, 6);
    expect(latencyPenalty(15_000)).toBeCloseTo(15, 6);
    expect(latencyPenalty(LATENCY_PENALTY_FULL_MS)).toBe(LATENCY_PENALTY_MAX);
    expect(latencyPenalty(120_000)).toBe(LATENCY_PENALTY_MAX); // 上限
    expect(latencyPenalty(-1)).toBe(LATENCY_NEUTRAL_PENALTY);
    expect(latencyPenalty(Number.NaN)).toBe(LATENCY_NEUTRAL_PENALTY);
  });

  it('失败率 = failures/(failures+successes)；无样本 0；脏事实防御', () => {
    expect(failureRate({ windowFailures: 0, windowSuccesses: 0 })).toBe(0);
    expect(failureRate({ windowFailures: 1, windowSuccesses: 3 })).toBe(0.25);
    expect(failureRate({ windowFailures: -5, windowSuccesses: 0 })).toBe(0);
    expect(failureRate({ windowFailures: 0, windowSuccesses: -1 })).toBe(0);
  });

  it('失败率罚分封顶 60：全失败 + 无延迟样本 = 100 - 60 - 15', () => {
    expect(healthScore({ healthStatus: 'healthy', windowFailures: 9, windowSuccesses: 0, latencyMs: null })).toBe(25);
    expect(healthScore({ healthStatus: 'healthy', windowFailures: 99, windowSuccesses: 0, latencyMs: null })).toBe(25);
  });

  it('证据不足（观测总数 < 3）→ 不因单次历史失败罚分（噪声不主导排序）', () => {
    expect(sampleSize({ windowFailures: 1, windowSuccesses: 0 })).toBe(1);
    expect(healthScore({ healthStatus: 'healthy', windowFailures: 1, windowSuccesses: 0, latencyMs: 0 })).toBe(100);
    expect(healthScore({ healthStatus: 'healthy', windowFailures: 2, windowSuccesses: 0, latencyMs: 0 })).toBe(100);
    // 达到最小样本量 → 按真实失败率罚分（3 失败/0 成功 = 100% → -60）
    expect(healthScore({ healthStatus: 'healthy', windowFailures: 3, windowSuccesses: 0, latencyMs: 0 })).toBe(40);
    expect(healthScore({ healthStatus: 'healthy', windowFailures: 2, windowSuccesses: 1, latencyMs: 0 })).toBeCloseTo(60, 6);
  });

  it('未知 healthStatus → 退化为 untested 基分（绝不臆造为 healthy）', () => {
    expect(healthScore({ healthStatus: 'weird' as never, windowFailures: 0, windowSuccesses: 0, latencyMs: 0 }))
      .toBe(HEALTH_BASE_SCORE.untested);
  });

  it('分数钳制在 0~100（脏事实不产生负分/超界）', () => {
    expect(healthScore({ healthStatus: HealthStatus.unhealthy, windowFailures: 100, windowSuccesses: 0, latencyMs: 60_000 })).toBe(0);
    expect(healthScore({ healthStatus: HealthStatus.healthy, windowFailures: 0, windowSuccesses: 0, latencyMs: 0 })).toBeLessThanOrEqual(100);
  });

  it('确定性：同输入同分数（4 位小数，排序可复现）', () => {
    const facts = { healthStatus: HealthStatus.healthy, windowFailures: 1, windowSuccesses: 2, latencyMs: 3333 };
    const score = healthScore(facts);
    expect(score).toBe(healthScore({ ...facts }));
    expect(score).toBe(Math.round(score * 1e4) / 1e4);
  });

  it('stableHash：确定性、区分键、非负 32 位（sticky tie-break 基础）', () => {
    expect(stableHash('run-1:p-a')).toBe(stableHash('run-1:p-a'));
    expect(stableHash('run-1:p-a')).not.toBe(stableHash('run-1:p-b'));
    const h = stableHash('x');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});
