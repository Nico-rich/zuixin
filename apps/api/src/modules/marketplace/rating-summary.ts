/**
 * M9-P6 评分聚合（**纯函数**：分布 → 均值/总数；无 IO，DB 只负责给定分布行）。
 *
 * 口径（与 catalog 服务逐字一致，单测锁定）：
 * - **只聚合已通过审核（moderationStatus='approved'）的评审**——pending/rejected 绝不进公开评分；
 * - 分布 = { 1..5 } 各档条数；均值 = Σ(rating×count)/Σcount，保留 2 位小数；
 * - 无已通过评审 → average = null（**绝不伪造 0 分**：0 分与"暂无评分"语义必须可区分）；
 * - 聚合是**只读投影**：评分只影响展示排序/文案，**绝不参与任何授权判定**（见 permission-disclosure.ts）。
 */

import { RATING_MAX, RATING_MIN } from './marketplace-status';

export type RatingDistribution = Record<1 | 2 | 3 | 4 | 5, number>;

export interface RatingCountRow {
  rating: number;
  count: number;
}

export interface RatingSummary {
  /** 已通过审核评审的算术平均（2 位小数）；无评审 → null */
  average: number | null;
  /** 已通过审核评审条数 */
  count: number;
  distribution: RatingDistribution;
}

export function emptyDistribution(): RatingDistribution {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

/**
 * 由 (rating, count) 行聚合出摘要。
 * - 非 1~5 的 rating 行**直接忽略**（防御 DB 脏数据，绝不因脏行放大分母）；
 * - 负数 count 忽略；小数 count 向下取整后按 0 处理（count 只可能是整数，防御性归一）。
 */
export function summarizeRatingDistribution(rows: readonly RatingCountRow[]): RatingSummary {
  const distribution = emptyDistribution();
  let weighted = 0;
  let count = 0;
  for (const row of rows) {
    const rating = row.rating;
    const n = Number.isFinite(row.count) ? Math.max(0, Math.trunc(row.count)) : 0;
    if (!Number.isInteger(rating) || rating < RATING_MIN || rating > RATING_MAX || n === 0) continue;
    distribution[rating as 1 | 2 | 3 | 4 | 5] += n;
    weighted += rating * n;
    count += n;
  }
  const average = count === 0 ? null : Math.round((weighted / count) * 100) / 100;
  return { average, count, distribution };
}

/** 由原始评分数组聚合（详情页/单测便利入口；与 DB 分布路径共用同一口径） */
export function summarizeRatings(ratings: readonly number[]): RatingSummary {
  const counts = new Map<number, number>();
  for (const rating of ratings) counts.set(rating, (counts.get(rating) ?? 0) + 1);
  return summarizeRatingDistribution([...counts].map(([rating, count]) => ({ rating, count })));
}
