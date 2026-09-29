import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_POLICY_THRESHOLDS, POLICY_THRESHOLDS_KEY, PolicyThresholdsPatchSchema, PolicyThresholdsSchema,
  assertPolicyThresholdsCoherent, deepMerge, readPolicyThresholds, resolvePolicyThresholds, resolvePolicyThresholdsStrict,
} from './policy-thresholds';

/**
 * M12-P4 策略阈值单测。
 * 第一组断言是**口径一致性**：外部化从不改变缺省行为——`DEFAULT_POLICY_THRESHOLDS` 必须与四处消费方的
 * 编译期常量逐项一致（任一处漂移 → 本测试失败，绝不静默分叉）。
 */
import { BAD_CTR, BAD_ROAS, GOOD_CTR, GOOD_ROAS } from '../feedback/feedback.service';
import { COMPARISON_THRESHOLD_PCT, RATING_BAD, RATING_GOOD } from '../creative-loop/insight-rules';
import { ANOMALY_THRESHOLD_PCT } from '../commerce/commerce-analysis.service';
import {
  FAILURE_PENALTY_MAX, FAILURE_RATE_MIN_SAMPLES, HEALTH_BASE_SCORE, LATENCY_NEUTRAL_PENALTY,
  LATENCY_PENALTY_FULL_MS, LATENCY_PENALTY_MAX,
} from '../provider-routing/health-score';

describe('M12-P4 阈值口径一致性（编译期常量 == 外部化缺省快照）', () => {
  it('feedback 阈值与 feedback.service 常量逐项一致', () => {
    expect(DEFAULT_POLICY_THRESHOLDS.feedback).toEqual({
      goodCtr: GOOD_CTR, goodRoas: GOOD_ROAS, badCtr: BAD_CTR, badRoas: BAD_ROAS,
    });
  });

  it('insight 阈值与 insight-rules 常量逐项一致', () => {
    expect(DEFAULT_POLICY_THRESHOLDS.insight).toEqual({
      ratingGood: RATING_GOOD, ratingBad: RATING_BAD, comparisonPct: COMPARISON_THRESHOLD_PCT,
    });
  });

  it('commerce 异常阈值与 commerce-analysis 常量一致', () => {
    expect(DEFAULT_POLICY_THRESHOLDS.commerce).toEqual({ anomalyPct: ANOMALY_THRESHOLD_PCT });
  });

  it('providerHealth 评分参数与 health-score 常量逐项一致', () => {
    expect(DEFAULT_POLICY_THRESHOLDS.providerHealth).toEqual({
      baseScores: { ...HEALTH_BASE_SCORE },
      failurePenaltyMax: FAILURE_PENALTY_MAX,
      failureRateMinSamples: FAILURE_RATE_MIN_SAMPLES,
      latencyPenaltyMax: LATENCY_PENALTY_MAX,
      latencyPenaltyFullMs: LATENCY_PENALTY_FULL_MS,
      latencyNeutralPenalty: LATENCY_NEUTRAL_PENALTY,
    });
  });

  it('缺省快照本身通过一致性校验（缺省绝不非法）', () => {
    expect(() => assertPolicyThresholdsCoherent(DEFAULT_POLICY_THRESHOLDS)).not.toThrow();
  });
});

describe('resolvePolicyThresholds：SystemSetting 优先、编译期常量兜底', () => {
  it('null / undefined / 非对象 / 空对象 → 完整缺省快照（缺行绝不失效）', () => {
    for (const raw of [null, undefined, 42, 'x', [], {}]) {
      expect(resolvePolicyThresholds(raw)).toEqual(DEFAULT_POLICY_THRESHOLDS);
    }
  });

  it('部分覆盖只改声明项（未声明项逐项回退缺省——一条坏字段不拖垮全部规则）', () => {
    const t = resolvePolicyThresholds({ feedback: { goodCtr: 0.05 }, insight: { ratingGood: 5 } });
    expect(t.feedback).toEqual({ ...DEFAULT_POLICY_THRESHOLDS.feedback, goodCtr: 0.05 });
    expect(t.insight).toEqual({ ...DEFAULT_POLICY_THRESHOLDS.insight, ratingGood: 5 });
    expect(t.commerce).toEqual(DEFAULT_POLICY_THRESHOLDS.commerce);
    expect(t.providerHealth).toEqual(DEFAULT_POLICY_THRESHOLDS.providerHealth);
  });

  it('嵌套部分覆盖（providerHealth.baseScores 单键）→ 同层其它键保留缺省', () => {
    const t = resolvePolicyThresholds({ providerHealth: { baseScores: { untested: 70 } } });
    expect(t.providerHealth.baseScores).toEqual({ healthy: 100, untested: 70, unhealthy: 0 });
    expect(t.providerHealth.latencyPenaltyMax).toBe(LATENCY_PENALTY_MAX);
  });

  it('白名单之外的子键被 strip（读取投影绝不回显，也绝不进入运行面）', () => {
    const t = resolvePolicyThresholds({ feedback: { goodCtr: 0.05, 偷渡: 'x' }, 未开放域: { a: 1 } });
    expect(t).toEqual({ ...DEFAULT_POLICY_THRESHOLDS, feedback: { ...DEFAULT_POLICY_THRESHOLDS.feedback, goodCtr: 0.05 } });
    expect(JSON.stringify(t)).not.toContain('偷渡');
    expect(JSON.stringify(t)).not.toContain('未开放域');
  });

  it('类型不符的脏值 → 该项回退缺省（外部直改 DB 也不把非法阈值投入判定面）', () => {
    const t = resolvePolicyThresholds({ feedback: { goodCtr: '0.9' }, insight: { ratingGood: 5.5 } });
    expect(t.feedback.goodCtr).toBe(GOOD_CTR);
    expect(t.insight.ratingGood).toBe(RATING_GOOD);
  });

  it('组合非法（badCtr > goodCtr / ratingBad ≥ ratingGood / 基分非单调）→ 整体回退缺省（读路径绝不抛错拖垮调用方）', () => {
    expect(resolvePolicyThresholds({ feedback: { badCtr: 0.9, goodCtr: 0.1 } })).toEqual(DEFAULT_POLICY_THRESHOLDS);
    expect(resolvePolicyThresholds({ insight: { ratingBad: 5, ratingGood: 5 } })).toEqual(DEFAULT_POLICY_THRESHOLDS);
    expect(resolvePolicyThresholds({ providerHealth: { baseScores: { healthy: 10, untested: 80 } } })).toEqual(DEFAULT_POLICY_THRESHOLDS);
  });
});

describe('resolvePolicyThresholdsStrict（写路径）：非法组合绝不放行', () => {
  /** 捕获同步抛错（断言 AppError.code——写路径失败必须是 400 语义，绝不 INTERNAL） */
  const codeOf = (fn: () => unknown): string | undefined => {
    try { fn(); return undefined; } catch (err) { return (err as { code?: string }).code; }
  };

  it('合法值 → 合并快照（与读路径同结果）', () => {
    const raw = { feedback: { goodCtr: 0.05 } };
    expect(resolvePolicyThresholdsStrict(raw)).toEqual(resolvePolicyThresholds(raw));
  });

  it('非法组合 → 抛 VALIDATION_ERROR（写路径不兜底、不静默接受）', () => {
    expect(codeOf(() => resolvePolicyThresholdsStrict({ insight: { ratingBad: 4, ratingGood: 4 } }))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => resolvePolicyThresholdsStrict({ providerHealth: { latencyNeutralPenalty: 90, latencyPenaltyMax: 30 } }))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => resolvePolicyThresholdsStrict({ feedback: { badRoas: 5, goodRoas: 2 } }))).toBe('VALIDATION_ERROR');
  });
});

describe('assertPolicyThresholdsCoherent：非法组合逐条报错', () => {
  const bad = (patch: (t: typeof DEFAULT_POLICY_THRESHOLDS) => void) => {
    const t = JSON.parse(JSON.stringify(DEFAULT_POLICY_THRESHOLDS)) as typeof DEFAULT_POLICY_THRESHOLDS;
    patch(t);
    expect(() => assertPolicyThresholdsCoherent(t)).toThrowError(/策略阈值组合非法/);
  };

  it('badCtr > goodCtr / badRoas > goodRoas', () => {
    bad((t) => { t.feedback.badCtr = 0.5; });
    bad((t) => { t.feedback.badRoas = 9; });
  });

  it('ratingBad ≥ ratingGood（中位评分不得同时落两档）', () => {
    bad((t) => { t.insight.ratingBad = t.insight.ratingGood; });
  });

  it('latencyNeutralPenalty > latencyPenaltyMax', () => {
    bad((t) => { t.providerHealth.latencyNeutralPenalty = 99; });
  });

  it('baseScores 非单调（healthy ≥ untested ≥ unhealthy）', () => {
    bad((t) => { t.providerHealth.baseScores.untested = 120; });
    bad((t) => { t.providerHealth.baseScores.unhealthy = 90; });
  });

  it('合法边界（相等）放行：badCtr == goodCtr、ratingBad == ratingGood-1', () => {
    const t = JSON.parse(JSON.stringify(DEFAULT_POLICY_THRESHOLDS)) as typeof DEFAULT_POLICY_THRESHOLDS;
    t.feedback.badCtr = t.feedback.goodCtr;
    t.feedback.badRoas = t.feedback.goodRoas;
    t.insight.ratingBad = t.insight.ratingGood - 1;
    t.providerHealth.baseScores = { healthy: 80, untested: 80, unhealthy: 80 };
    expect(() => assertPolicyThresholdsCoherent(t)).not.toThrow();
  });
});

describe('deepMerge（补丁语义：递归合并，标量/数组/null 替换）', () => {
  it('对象递归；补丁未声明的键保留', () => {
    expect(deepMerge({ a: { x: 1, y: 2 }, b: 3 }, { a: { y: 9 } })).toEqual({ a: { x: 1, y: 9 }, b: 3 });
  });

  it('数组/标量/null 一律替换（绝不把"设为 null"误读为"保持原值"）', () => {
    expect(deepMerge({ a: [1, 2], b: 3 }, { a: [9], b: null })).toEqual({ a: [9], b: null });
  });

  it('新键直接落入（不存在的路径不臆造父对象）', () => {
    expect(deepMerge({ a: 1 }, { z: { deep: true } })).toEqual({ a: 1, z: { deep: true } });
  });

  it('基准非对象 → 补丁整体替换（绝不与标量合并）', () => {
    expect(deepMerge(5, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge({ a: 1 }, 5)).toBe(5);
  });
});

describe('readPolicyThresholds（消费方入口）', () => {
  it('读 policyThresholds 键（select value）→ 缺行回退缺省', async () => {
    const prisma = { systemSetting: { findUnique: vi.fn(async () => null) } };
    expect(await readPolicyThresholds(prisma as never)).toEqual(DEFAULT_POLICY_THRESHOLDS);
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledWith({ where: { key: POLICY_THRESHOLDS_KEY }, select: { value: true } });
  });

  it('有行 → 返回该行的生效快照（单次读，绝不 N 次）', async () => {
    const prisma = { systemSetting: { findUnique: vi.fn(async () => ({ value: { commerce: { anomalyPct: 25 } } })) } };
    const t = await readPolicyThresholds(prisma as never);
    expect(t.commerce.anomalyPct).toBe(25);
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('传给消费方的永远是完整快照（调用方无需做空值判断）', async () => {
    const prisma = { systemSetting: { findUnique: vi.fn(async () => ({ value: '脏行' })) } };
    expect(await readPolicyThresholds(prisma as never)).toEqual(DEFAULT_POLICY_THRESHOLDS);
  });
});

describe('schema 面（可写 strict vs 读取 strip）', () => {
  it('可写面拒绝未知子键/未知顶层键（strict → 400，绝不静默丢弃）', () => {
    expect(PolicyThresholdsPatchSchema.safeParse({ feedback: { goodCtr: 0.05 } }).success).toBe(true);
    expect(PolicyThresholdsPatchSchema.safeParse({ feedback: { goodCtr: 0.05, nope: 1 } }).success).toBe(false);
    expect(PolicyThresholdsPatchSchema.safeParse({ 越权域: { a: 1 } }).success).toBe(false);
    expect(PolicyThresholdsPatchSchema.safeParse({ providerHealth: { baseScores: { healthy: 1, nope: 2 } } }).success).toBe(false);
  });

  it('可写面拒绝越界值（CTR > 1 / 基分 > 100 / 样本量 0）', () => {
    expect(PolicyThresholdsPatchSchema.safeParse({ feedback: { goodCtr: 1.5 } }).success).toBe(false);
    expect(PolicyThresholdsPatchSchema.safeParse({ providerHealth: { baseScores: { healthy: 101 } } }).success).toBe(false);
    expect(PolicyThresholdsPatchSchema.safeParse({ providerHealth: { failureRateMinSamples: 0 } }).success).toBe(false);
  });

  it('读取面 strip 未知子键（GET 投影不回声任何白名单之外的内容）', () => {
    const parsed = PolicyThresholdsSchema.safeParse({ feedback: { goodCtr: 0.05, 偷渡: 'x' }, 越权域: 1 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ feedback: { goodCtr: 0.05 } });
  });
});
