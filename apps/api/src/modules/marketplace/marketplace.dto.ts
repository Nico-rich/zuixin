import { z } from 'zod';
import {
  MARKETPLACE_CATEGORIES, MODERATION_TARGETS, PUBLICATION_STATUSES, RATING_MAX, RATING_MIN,
} from './marketplace-status';

/**
 * M9-P6 Marketplace DTO（zod；全部 strictObject——多余字段直接拒绝，绝不静默丢弃）。
 * 归属字段一律服务端解析：客户端只能提交 id，**userId / 发布者组织永不来自请求体**。
 */
const Id = z.string().min(8).max(100); // 组织 id 含 personal-{uuid} 前缀，非纯 UUID

/** changelog 条目（[{version, notes}]——与 schema 注释逐字一致） */
export const ChangelogEntrySchema = z.strictObject({
  version: z.string().min(1).max(40),
  notes: z.string().min(1).max(1_000),
});
export const ChangelogSchema = z.array(ChangelogEntrySchema).max(20);

/** 兼容性声明（平台版本区间 + 备注；纯声明，绝不改变平台校验行为） */
export const CompatibilitySchema = z.strictObject({
  minPlatformVersion: z.string().min(1).max(40).optional(),
  maxPlatformVersion: z.string().min(1).max(40).optional(),
  notes: z.string().max(500).optional(),
});

/** 创建发布条目（草稿）：extensionId 必须属于调用方可管理的组织（或平台管理员 + 平台级扩展） */
export const CreatePublicationSchema = z.strictObject({
  extensionId: Id,
  category: z.enum(MARKETPLACE_CATEGORIES),
  description: z.string().min(10).max(2_000),
  changelog: ChangelogSchema.optional(),
  compatibility: CompatibilitySchema.optional(),
});

/** 编辑：**仅 draft/rejected 可编辑**（已上架须先撤回——避免"已公开内容静默变更"） */
export const UpdatePublicationSchema = z.strictObject({
  category: z.enum(MARKETPLACE_CATEGORIES).optional(),
  description: z.string().min(10).max(2_000).optional(),
  changelog: ChangelogSchema.nullable().optional(),
  compatibility: CompatibilitySchema.nullable().optional(),
});

/** 治理侧驳回（下架）必须给理由（落审计，不落公开文案） */
export const RejectPublicationSchema = z.strictObject({
  reason: z.string().min(4).max(500),
});

/** 评分：1~5 整数（服务层再用 isValidRating 复核——同一口径两处断言） */
export const UpsertReviewSchema = z.strictObject({
  rating: z.number().int().min(RATING_MIN).max(RATING_MAX),
  body: z.string().max(2_000).nullable().optional(),
});

/** 审核：目标只能是 approved/rejected（pending 绝不可设） */
export const ModerateReviewSchema = z.strictObject({
  status: z.enum(MODERATION_TARGETS),
  reason: z.string().min(4).max(500).optional(),
});

/** 目录检索：默认只列 published；非 published 状态必须带 organizationId（仅发布者组织成员可见） */
export const ListPublicationsSchema = z.strictObject({
  q: z.string().min(1).max(100).optional(),
  category: z.enum(MARKETPLACE_CATEGORIES).optional(),
  status: z.enum([...PUBLICATION_STATUSES, 'all'] as const).optional(),
  organizationId: Id.optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** 评审列表：默认只列 approved；moderationStatus 过滤须具备审核权（owner/admin） */
export const ListReviewsSchema = z.strictObject({
  moderationStatus: z.enum(['pending', 'approved', 'rejected'] as const).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export type CreatePublicationDto = z.infer<typeof CreatePublicationSchema>;
export type UpdatePublicationDto = z.infer<typeof UpdatePublicationSchema>;
export type RejectPublicationDto = z.infer<typeof RejectPublicationSchema>;
export type UpsertReviewDto = z.infer<typeof UpsertReviewSchema>;
export type ModerateReviewDto = z.infer<typeof ModerateReviewSchema>;
export type ListPublicationsDto = z.infer<typeof ListPublicationsSchema>;
export type ListReviewsDto = z.infer<typeof ListReviewsSchema>;
