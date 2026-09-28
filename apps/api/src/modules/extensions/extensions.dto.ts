import { z } from 'zod';
import { EXTENSION_KINDS } from './manifest';

/** 扩展 slug（同时作为 tool 命名空间 ext.<slug>.<name> 的中段） */
export const ExtensionSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,49}$/, 'slug 只能是小写字母/数字/中划线（2~50）');

/** POST /extensions：manifest 为声明式 JSON（严格校验在 ExtensionsService.parseManifest） */
export const CreateExtensionSchema = z.strictObject({
  organizationId: z.string().min(1).max(64).nullish(),
  name: z.string().min(1).max(100),
  slug: ExtensionSlugSchema,
  description: z.string().max(500).optional(),
  kind: z.enum(EXTENSION_KINDS),
  manifest: z.unknown(),
});

/** PATCH /extensions/:id：修改即生成/更新 draft 版本（published 版本行永不修改） */
export const UpdateExtensionSchema = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  manifest: z.unknown().optional(),
});

export const PublishSchema = z.strictObject({
  versionId: z.string().min(1).max(64).optional(),
});

export const InstallSchema = z.strictObject({
  organizationId: z.string().min(1).max(64),
  versionId: z.string().min(1).max(64).optional(),
  /** 安装配置（provider 类必须提供 apiKey——manifest 绝不携带密钥；落库前脱敏） */
  config: z.record(z.string().min(1).max(64), z.unknown()).optional(),
});

export const OrgScopedSchema = z.strictObject({
  organizationId: z.string().min(1).max(64),
});

/** M10-P14：组织白名单条目（extension owner 增删；目标组织必须存在且未软删） */
export const AllowlistEntrySchema = z.strictObject({
  organizationId: z.string().min(1).max(64),
});
