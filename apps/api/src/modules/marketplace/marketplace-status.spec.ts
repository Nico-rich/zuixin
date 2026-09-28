import { describe, it, expect } from 'vitest';
import {
  MARKETPLACE_CATEGORIES, MODERATION_TARGETS, PUBLICATION_ACTIONS, PUBLICATION_STATUSES, RATING_MAX, RATING_MIN,
  REVIEW_MODERATION_STATUSES, assertModerationTransition, assertPublicationTransition, canModerate,
  canTransitionPublication, countsTowardRating, isMarketplaceCategory, isModerationTarget, isPublicationAction,
  isPublicationStatus, isPubliclyVisible, isReviewModerationStatus, isValidRating, nextPublicationStatus,
} from './marketplace-status';

/**
 * M9-P6 状态机单测：发布（draft/published/rejected）与评审审核（pending/approved/rejected）。
 * deny-by-default：未列出的边一律拒绝；rejected 无直达 published 的边（强制重走门禁）。
 */
describe('marketplace-status（M9-P6 状态机与常量）', () => {
  it('状态/动作/审核目标全集固定（与 schema 注释逐字一致）', () => {
    expect([...PUBLICATION_STATUSES]).toEqual(['draft', 'published', 'rejected']);
    expect([...PUBLICATION_ACTIONS]).toEqual(['publish', 'withdraw', 'reject', 'revise']);
    expect([...REVIEW_MODERATION_STATUSES]).toEqual(['pending', 'approved', 'rejected']);
    expect([...MODERATION_TARGETS]).toEqual(['approved', 'rejected']);
    expect(RATING_MIN).toBe(1);
    expect(RATING_MAX).toBe(5);
  });

  it('类型守卫：已知值 true，未知值/非字符串一律 false', () => {
    for (const s of PUBLICATION_STATUSES) expect(isPublicationStatus(s)).toBe(true);
    expect(isPublicationStatus('archived')).toBe(false);
    expect(isPublicationStatus('')).toBe(false);
    expect(isPublicationStatus(null)).toBe(false);
    expect(isPublicationStatus(3)).toBe(false);
    for (const a of PUBLICATION_ACTIONS) expect(isPublicationAction(a)).toBe(true);
    expect(isPublicationAction('delete')).toBe(false);
    for (const s of REVIEW_MODERATION_STATUSES) expect(isReviewModerationStatus(s)).toBe(true);
    expect(isReviewModerationStatus('hidden')).toBe(false);
    expect(isModerationTarget('approved')).toBe(true);
    expect(isModerationTarget('rejected')).toBe(true);
    expect(isModerationTarget('pending')).toBe(false);
  });

  it('发布允许边：draft→published；published→draft|rejected；rejected→draft（**无直达 published**）', () => {
    expect(nextPublicationStatus('draft', 'publish')).toBe('published');
    expect(nextPublicationStatus('published', 'withdraw')).toBe('draft');
    expect(nextPublicationStatus('published', 'reject')).toBe('rejected');
    expect(nextPublicationStatus('rejected', 'revise')).toBe('draft');
    // 未列出的边
    expect(nextPublicationStatus('rejected', 'publish')).toBeNull(); // 必须先 revise 重走门禁
    expect(nextPublicationStatus('draft', 'withdraw')).toBeNull();
    expect(nextPublicationStatus('draft', 'reject')).toBeNull();
    expect(nextPublicationStatus('rejected', 'withdraw')).toBeNull();
    expect(nextPublicationStatus('published', 'revise')).toBeNull();
    expect(nextPublicationStatus('published', 'publish')).toBeNull(); // 幂等上架由服务层拒绝（非状态自环）
  });

  it('canTransitionPublication 与 nextPublicationStatus 同源（同一份允许边表）', () => {
    expect(canTransitionPublication('draft', 'publish')).toBe(true);
    expect(canTransitionPublication('rejected', 'publish')).toBe(false);
    expect(canTransitionPublication('published', 'withdraw')).toBe(true);
  });

  it('assertPublicationTransition：非法边抛 VALIDATION_ERROR，消息含 from/action 可诊断', () => {
    expect(assertPublicationTransition('draft', 'publish')).toBe('published');
    expect(() => assertPublicationTransition('rejected', 'publish')).toThrowError(/rejected --publish-->/);
    try {
      assertPublicationTransition('published', 'revise');
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('VALIDATION_ERROR');
      expect((err as Error).message).toContain('发布状态不允许该操作');
    }
  });

  it('isPubliclyVisible：仅 published 进公开目录', () => {
    expect(isPubliclyVisible('published')).toBe(true);
    expect(isPubliclyVisible('draft')).toBe(false);
    expect(isPubliclyVisible('rejected')).toBe(false);
  });

  it('审核允许边：pending→approved|rejected、approved↔rejected；pending 永不可设', () => {
    expect(canModerate('pending', 'approved')).toBe(true);
    expect(canModerate('pending', 'rejected')).toBe(true);
    expect(canModerate('approved', 'rejected')).toBe(true);
    expect(canModerate('rejected', 'approved')).toBe(true);
    // 同状态重复提交 = 幂等 no-op
    expect(canModerate('approved', 'approved')).toBe(true);
    expect(canModerate('rejected', 'rejected')).toBe(true);
    expect(canModerate('pending', 'pending' as never)).toBe(false); // 类型上也不允许
    expect(() => assertModerationTransition('pending', 'approved')).not.toThrow();
    expect(() => assertModerationTransition('approved', 'approved')).not.toThrow();
  });

  it('countsTowardRating：仅 approved 计入公开聚合', () => {
    expect(countsTowardRating('approved')).toBe(true);
    expect(countsTowardRating('pending')).toBe(false);
    expect(countsTowardRating('rejected')).toBe(false);
  });

  it('isValidRating：仅 1~5 整数（布尔/字符串/NaN/浮点/越界一律拒绝）', () => {
    for (const r of [1, 2, 3, 4, 5]) expect(isValidRating(r)).toBe(true);
    for (const bad of [0, 6, -1, 2.5, NaN, Infinity, '5', null, undefined, {}, true]) {
      expect(isValidRating(bad)).toBe(false);
    }
  });

  it('分类白名单：固定枚举且全部命中守卫（客户端字面量不可扩展）', () => {
    expect(MARKETPLACE_CATEGORIES.length).toBeGreaterThan(5);
    expect(new Set(MARKETPLACE_CATEGORIES).size).toBe(MARKETPLACE_CATEGORIES.length);
    for (const c of MARKETPLACE_CATEGORIES) expect(isMarketplaceCategory(c)).toBe(true);
    expect(isMarketplaceCategory('malware')).toBe(false);
    expect(isMarketplaceCategory('OTHER')).toBe(false);
  });
});
