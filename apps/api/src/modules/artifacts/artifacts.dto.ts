import { z } from 'zod';

/**
 * GET /artifacts 过滤（M13-W9 只读展示面）。
 * 未知 query 键由 zod 默认剥除（不报错）——只读列表不接受任何写语义参数，
 * **尤其没有 userId/organizationId**：归属只由服务端从 JWT 判定。
 */
export const ListArtifactsQuerySchema = z.object({
  type: z.enum(['creative_brief', 'image', 'video', 'report', 'analysis', 'other']).optional(),
  projectId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type ListArtifactsQuery = z.infer<typeof ListArtifactsQuerySchema>;
