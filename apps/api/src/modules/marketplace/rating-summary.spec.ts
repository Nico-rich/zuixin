import { describe, it, expect } from 'vitest';
import { emptyDistribution, summarizeRatingDistribution, summarizeRatings } from './rating-summary';

/**
 * M9-P6 评分聚合单测：分布 → 均值/条数。
 * 关键口径：无评审 → average=null（**绝不伪造 0 分**）；脏行（越界/非整数/负计数）一律忽略，绝不放大分母。
 */
describe('rating-summary（M9-P6 评分聚合）', () => {
  it('空集：average=null（与"0 分"可区分）、count=0、分布全零', () => {
    const empty = summarizeRatingDistribution([]);
    expect(empty).toEqual({ average: null, count: 0, distribution: emptyDistribution() });
    expect(summarizeRatings([]).average).toBeNull();
  });

  it('单档：均值等于该档，计数正确', () => {
    expect(summarizeRatingDistribution([{ rating: 5, count: 3 }])).toEqual({
      average: 5, count: 3, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 3 },
    });
  });

  it('多档加权均值保留 2 位小数（4×2 + 5×1 = 13/3 ≈ 4.33）', () => {
    const summary = summarizeRatingDistribution([{ rating: 4, count: 2 }, { rating: 5, count: 1 }]);
    expect(summary.average).toBe(4.33);
    expect(summary.count).toBe(3);
    expect(summary.distribution[4]).toBe(2);
    expect(summary.distribution[5]).toBe(1);
  });

  it('summarizeRatings 与分布路径同口径（原始评分数组入口）', () => {
    const a = summarizeRatings([1, 1, 3, 5, 5, 5]);
    const b = summarizeRatingDistribution([{ rating: 1, count: 2 }, { rating: 3, count: 1 }, { rating: 5, count: 3 }]);
    expect(a).toEqual(b);
    expect(a.average).toBe(3.33);
    expect(a.count).toBe(6);
  });

  it('脏数据防御：越界/非整数/NaN 计数/负计数一律忽略（绝不计入分母）', () => {
    const summary = summarizeRatingDistribution([
      { rating: 0, count: 5 }, { rating: 6, count: 5 }, { rating: 2.5, count: 5 },
      { rating: 5, count: NaN }, { rating: 4, count: -3 },
      { rating: 3, count: 2 },
    ]);
    expect(summary.count).toBe(2);
    expect(summary.average).toBe(3);
    expect(summary.distribution).toEqual({ 1: 0, 2: 0, 3: 2, 4: 0, 5: 0 });
  });

  it('聚合是纯函数：多次调用同输入同输出，不共享可变状态', () => {
    const rows = [{ rating: 5, count: 1 }];
    const first = summarizeRatingDistribution(rows);
    first.distribution[5] = 999; // 篡改返回值
    expect(summarizeRatingDistribution(rows).distribution[5]).toBe(1);
  });
});
