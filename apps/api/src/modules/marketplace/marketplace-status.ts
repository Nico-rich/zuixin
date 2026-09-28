/**
 * M9-P6 Marketplace 状态机 / 目录常量（**纯函数、无 IO**——单测、服务层与 e2e 共用同一份判定）。
 *
 * 两条状态机（与 schema 注释逐字一致，绝不新增状态）：
 * - 发布（ExtensionPublication.status：draft | published | rejected）
 *     draft      --publish-->  published      发布（门禁：扩展已通过 M8-P6 平台校验 + 签名有效）
 *     published  --withdraw--> draft          撤回（作者侧下架，可再发布）
 *     published  --reject-->   rejected       驳回（治理侧下架，须给理由）
 *     rejected   --revise-->   draft          重新编辑（**rejected 无直达 published 的边**：
 *                                             修订后必须重走一次 publish 门禁，绝不绕过平台校验）
 * - 评审审核（ExtensionReview.moderationStatus：pending | approved | rejected）
 *     pending  --> approved | rejected       首次审核
 *     approved --> rejected                  通过后仍可下架（撤销通过）
 *     rejected --> approved                  误拒可恢复
 *     终点 pending **永不**可设（不可回退为待审）；同状态重复提交视为幂等 no-op（不抛错）。
 *
 * 权限语义（贯穿本模块）：状态机只决定"条目是否可见/是否计入聚合"，
 * **绝不**影响扩展可获得的权限——权限恒为 manifest ∩ 平台白名单 ∩ 组织策略（Pre-M9 F4 语义）。
 */

import { AppError, ErrorCode } from '../../common/errors/app-error';

// ===== 发布状态机 =====

export const PUBLICATION_STATUSES = ['draft', 'published', 'rejected'] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/** 发布动作（每个动作语义唯一：publish 上架 / withdraw 撤回 / reject 驳回 / revise 修订） */
export const PUBLICATION_ACTIONS = ['publish', 'withdraw', 'reject', 'revise'] as const;
export type PublicationAction = (typeof PUBLICATION_ACTIONS)[number];

/** 允许边（未列出的一律拒绝——deny-by-default） */
export const PUBLICATION_TRANSITIONS: Readonly<
  Record<PublicationStatus, Readonly<Partial<Record<PublicationAction, PublicationStatus>>>>
> = {
  draft: { publish: 'published' },
  published: { withdraw: 'draft', reject: 'rejected' },
  rejected: { revise: 'draft' },
};

export function isPublicationStatus(value: unknown): value is PublicationStatus {
  return typeof value === 'string' && (PUBLICATION_STATUSES as readonly string[]).includes(value);
}

export function isPublicationAction(value: unknown): value is PublicationAction {
  return typeof value === 'string' && (PUBLICATION_ACTIONS as readonly string[]).includes(value);
}

/** 目标状态（非法边 → null；调用方据此决定 400/409） */
export function nextPublicationStatus(current: PublicationStatus, action: PublicationAction): PublicationStatus | null {
  return PUBLICATION_TRANSITIONS[current][action] ?? null;
}

export function canTransitionPublication(current: PublicationStatus, action: PublicationAction): boolean {
  return nextPublicationStatus(current, action) !== null;
}

/** 非法推进一律 VALIDATION_ERROR（消息含 from/action，便于诊断；绝不静默 no-op 到错误状态） */
export function assertPublicationTransition(current: PublicationStatus, action: PublicationAction): PublicationStatus {
  const next = nextPublicationStatus(current, action);
  if (!next) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `发布状态不允许该操作：${current} --${action}-->（允许：${Object.keys(PUBLICATION_TRANSITIONS[current]).join('/') || '无出边'}）`,
    );
  }
  return next;
}

/** 公开目录仅收录 published（其余状态只在发布者组织内可见——见 catalog 服务） */
export function isPubliclyVisible(status: PublicationStatus): boolean {
  return status === 'published';
}

// ===== 评审审核状态机 =====

export const REVIEW_MODERATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ReviewModerationStatus = (typeof REVIEW_MODERATION_STATUSES)[number];

/** 审核目标只能是终态两值（**pending 不可被设为目标**） */
export const MODERATION_TARGETS = ['approved', 'rejected'] as const;
export type ModerationTarget = (typeof MODERATION_TARGETS)[number];

export const REVIEW_MODERATION_TRANSITIONS: Readonly<Record<ReviewModerationStatus, readonly ModerationTarget[]>> = {
  pending: ['approved', 'rejected'],
  approved: ['rejected'],
  rejected: ['approved'],
};

export function isReviewModerationStatus(value: unknown): value is ReviewModerationStatus {
  return typeof value === 'string' && (REVIEW_MODERATION_STATUSES as readonly string[]).includes(value);
}

export function isModerationTarget(value: unknown): value is ModerationTarget {
  return typeof value === 'string' && (MODERATION_TARGETS as readonly string[]).includes(value);
}

/**
 * 同一状态重复提交 = 幂等 no-op（审核接口可安全重试）；否则必须是允许边。
 * 非目标值（`pending`/未知字面量）一律 false——**pending 永不可被设**，运行时同样兜底。
 */
export function canModerate(current: ReviewModerationStatus, target: ModerationTarget): boolean {
  if (!isModerationTarget(target)) return false;
  if (current === target) return true;
  return (REVIEW_MODERATION_TRANSITIONS[current] as readonly string[]).includes(target);
}

export function assertModerationTransition(current: ReviewModerationStatus, target: ModerationTarget): void {
  if (!canModerate(current, target)) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `评审审核状态不允许该推进：${current} → ${target}（允许：${REVIEW_MODERATION_TRANSITIONS[current].join('/')}）`,
    );
  }
}

/** 仅 approved 计入公开评分聚合与公开展示（pending/rejected 绝不进聚合——审核是前置门禁） */
export function countsTowardRating(status: ReviewModerationStatus): boolean {
  return status === 'approved';
}

// ===== 评分 =====

export const RATING_MIN = 1;
export const RATING_MAX = 5;

/** 1~5 整数（服务层校验；zod 只做类型/范围初筛——两处口径一致由单测锁定） */
export function isValidRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= RATING_MIN && value <= RATING_MAX;
}

// ===== 目录分类 / 分页 =====

/** 分类白名单（固定枚举：绝不接受客户端字面量——防分类枚举污染与注入） */
export const MARKETPLACE_CATEGORIES = [
  'analytics', 'automation', 'communication', 'content', 'data', 'developer-tools',
  'finance', 'knowledge', 'productivity', 'research', 'sales', 'other',
] as const;
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

export function isMarketplaceCategory(value: unknown): value is MarketplaceCategory {
  return typeof value === 'string' && (MARKETPLACE_CATEGORIES as readonly string[]).includes(value);
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
/** 关键词检索时先解析命中的扩展 id 上限（读路径有界，绝不无界扫表） */
export const KEYWORD_EXTENSION_SCAN_LIMIT = 500;
/** 详情页回显的已通过评审条数上限 */
export const REVIEW_PREVIEW_LIMIT = 20;
