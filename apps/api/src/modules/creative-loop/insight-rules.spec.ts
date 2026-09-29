import { describe, it, expect } from 'vitest';
import {
  COMPARISON_THRESHOLD_PCT, EMPTY_PERF_FACTS, FACT_LAYER_KEYS, PERF_DERIVED_CRITERIA_METRICS, RATING_BAD, RATING_GOOD,
  SUCCESS_CRITERIA_METRICS, agentPerformanceIds, assertFactsUnchanged, comparePeriods, derivePerfMetrics,
  excludeAgentPerformance, factsHashOf, isCriteriaSatisfied, isPerfDerivedMetric,
  stableStringify, sumPerfFacts, summarizeRatings,
} from './insight-rules';

/** 无 IO 的规则层事实（与 M7-P8 derive 同公式：分母 0 → 0，保留两位） */
describe('insight-rules：绩效事实求和与派生（服务端计算）', () => {
  it('sumPerfFacts：逐列求和（缺列按 0；金额两位）', () => {
    const facts = sumPerfFacts([
      { impressions: 1000, clicks: 30, spend: 10.115, conversions: 3, revenue: 25.339, orders: 3 },
      { impressions: 500, clicks: 10, spend: 4.115, conversions: 1, revenue: 9.339, orders: 2 },
    ]);
    expect(facts).toEqual({ impressions: 1500, clicks: 40, spend: 14.23, conversions: 4, revenue: 34.68, orders: 5 });
    expect(sumPerfFacts([])).toEqual(EMPTY_PERF_FACTS);
  });

  it('derivePerfMetrics：ctr/cvr/roas/cpc 公式（分母 0 → 0，绝不产生 NaN/Infinity）', () => {
    expect(derivePerfMetrics({ impressions: 1000, clicks: 50, spend: 100, conversions: 5, revenue: 300, orders: 5 }))
      .toEqual({ ctr: 0.05, cvr: 0.1, roas: 3, cpc: 2 });
    expect(derivePerfMetrics(EMPTY_PERF_FACTS)).toEqual({ ctr: 0, cvr: 0, roas: 0, cpc: 0 });
  });

  it('summarizeRatings：分布/均值/好评率/差评率（阈值与 M7-P8 一致：>=4 好、<=2 差；越界值丢弃）', () => {
    const r = summarizeRatings([5, 4, 3, 2, 1, 5, 0, 9, Number.NaN]);
    expect(r.count).toBe(6); // 0/9/NaN 越界或非数 → 丢弃
    expect(r.distribution).toEqual({ '1': 1, '2': 1, '3': 1, '4': 1, '5': 2 });
    expect(r.avgRating).toBe(3.33);
    expect(r.positiveRate).toBe(0.5); // 5/4/5
    expect(r.negativeRate).toBe(0.33); // 1/2
    expect(RATING_GOOD).toBe(4);
    expect(RATING_BAD).toBe(2);
    expect(summarizeRatings([])).toEqual({
      count: 0, avgRating: 0, distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }, positiveRate: 0, negativeRate: 0,
    });
  });

  it('comparePeriods：双向记录 + 阈值标注；前一期为 0 或缺失 → 跳过（绝不臆造 ∞ 变化）', () => {
    const rows = comparePeriods(
      { ctr: 0.05, roas: 2, cvr: 0.05, cpc: 0 },
      { ctr: 0.04, roas: 3, cvr: 0, cpc: 2 },
      ['ctr', 'roas', 'cvr', 'cpc', 'missing'],
    );
    const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r]));
    expect(byMetric.ctr).toMatchObject({ base: 0.04, compare: 0.05, changePct: 25, direction: 'up', beyondThreshold: true, rule: 'server-comparison' });
    expect(byMetric.roas).toMatchObject({ changePct: -33.33, direction: 'down', beyondThreshold: true });
    expect(byMetric.cpc).toMatchObject({ changePct: -100, direction: 'down', beyondThreshold: true });
    expect(byMetric.cvr).toBeUndefined(); // 前一期 0 → 跳过
    expect(byMetric.missing).toBeUndefined(); // 任一侧缺失 → 跳过
    expect(COMPARISON_THRESHOLD_PCT).toBe(10);
    expect(comparePeriods({ a: 1 }, { a: 1 }, ['a'])[0]).toMatchObject({ changePct: 0, direction: 'flat', beyondThreshold: false });
  });

  it('isCriteriaSatisfied：gte/lte 判定；事实缺失 → 不可评估（绝不把"没有数据"当"达成"）', () => {
    expect(isCriteriaSatisfied({ metric: 'roas', op: 'gte', value: 2 }, { roas: 3 })).toMatchObject({ satisfiable: true, satisfied: true, actual: 3 });
    expect(isCriteriaSatisfied({ metric: 'roas', op: 'gte', value: 3 }, { roas: 3 })).toMatchObject({ satisfiable: true, satisfied: true });
    expect(isCriteriaSatisfied({ metric: 'ctr', op: 'lte', value: 0.08 }, { ctr: 0.05 })).toMatchObject({ satisfiable: true, satisfied: true });
    expect(isCriteriaSatisfied({ metric: 'avg_score', op: 'gte', value: 0.8 }, { avg_score: null })).toMatchObject({ satisfiable: false, satisfied: false, actual: null });
    expect(isCriteriaSatisfied({ metric: 'pass_rate', op: 'gte', value: 0.5 }, {})).toMatchObject({ satisfiable: false, satisfied: false });
  });
});

/** M12-P1 来源判别（纯函数）：agent 工具账本 → 被排除的绩效行；只认账本形状，绝不误伤 */
describe('insight-rules：绩效事实来源判别（M12-P1 审计 R1）', () => {
  it('agentPerformanceIds：只从账本载荷提取 performanceId（形状不符/类型不符一律忽略）', () => {
    const ids = agentPerformanceIds([
      { performanceId: 'perf-1', facts: {}, derived: {}, layering: {} }, // performance.capture 的返回值形状
      { performanceId: 'perf-2', extra: true },
      { performanceId: 42 }, // 类型不符 → 忽略
      { performanceId: '' }, // 空串 → 忽略
      { someOther: 'payload' }, // 别的工具账本 → 忽略
      null,
      undefined,
      'not-an-object',
    ]);
    expect([...ids].sort()).toEqual(['perf-1', 'perf-2']);
    expect(agentPerformanceIds([]).size).toBe(0);
  });

  it('excludeAgentPerformance：按 id 排除并回报计数（绝不静默丢弃事实）', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(excludeAgentPerformance(rows, new Set(['b']))).toEqual({
      rows: [{ id: 'a' }, { id: 'c' }], excludedAgentRows: 1,
    });
    expect(excludeAgentPerformance(rows, new Set())).toEqual({ rows, excludedAgentRows: 0 });
    expect(excludeAgentPerformance(rows, new Set(['a', 'b', 'c']))).toEqual({ rows: [], excludedAgentRows: 3 });
    expect(excludeAgentPerformance([], new Set(['x']))).toEqual({ rows: [], excludedAgentRows: 0 });
  });

  it('判据指标来源归属：roas/ctr 受来源谓词约束；avg_score/pass_rate（M9-P1）不受', () => {
    expect(SUCCESS_CRITERIA_METRICS).toEqual(['avg_score', 'pass_rate', 'roas', 'ctr']);
    expect(PERF_DERIVED_CRITERIA_METRICS).toEqual(['roas', 'ctr']);
    expect(isPerfDerivedMetric('roas')).toBe(true);
    expect(isPerfDerivedMetric('ctr')).toBe(true);
    expect(isPerfDerivedMetric('avg_score')).toBe(false);
    expect(isPerfDerivedMetric('pass_rate')).toBe(false);
  });
});

/** 事实层指纹：稳定序列化 + sha256（"解读绝不改写事实"的可验证锚点） */
describe('insight-rules：稳定序列化 / factsHash / 事实不变断言', () => {
  it('stableStringify：键序无关（同值必得同串）；数组保序；undefined 键丢弃', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, 4] } })).toBe(stableStringify({ a: { c: [3, 4], d: 2 }, b: 1 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(stableStringify(null)).toBe('null');
  });

  it('factsHashOf：同 facts 必同 hash；facts 或 derived 任一变化 → hash 变化', () => {
    const facts = { impressions: 100, clicks: 10 };
    const derived = { ctr: 0.1 };
    expect(factsHashOf(facts, derived)).toBe(factsHashOf({ ...facts }, { ...derived }));
    expect(factsHashOf(facts, derived)).toMatch(/^[0-9a-f]{64}$/);
    expect(factsHashOf({ ...facts, clicks: 11 }, derived)).not.toBe(factsHashOf(facts, derived));
    expect(factsHashOf(facts, { ctr: 0.2 })).not.toBe(factsHashOf(facts, derived));
  });

  it('assertFactsUnchanged：事实层逐字节相等才放行；解读字段变化不影响（隔离不变量）', () => {
    const before = { facts: { a: 1 }, derived: { b: 2 }, interpretation: null };
    const after = { facts: { a: 1 }, derived: { b: 2 }, interpretation: { source: 'llm-interpretation', items: ['x'] } };
    expect(() => assertFactsUnchanged(before, after)).not.toThrow();
    expect(FACT_LAYER_KEYS).toEqual(['facts', 'derived']);
    expect(() => assertFactsUnchanged(before, { ...after, facts: { a: 2 } })).toThrowError(/事实层被解读改写/);
    expect(() => assertFactsUnchanged(before, { ...after, derived: { b: 3 } })).toThrowError(/事实层被解读改写/);
    try {
      assertFactsUnchanged(before, { ...after, derived: { b: 3 } });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('INTERNAL');
    }
  });
});
