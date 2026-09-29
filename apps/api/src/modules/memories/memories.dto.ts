import { z } from 'zod';

export const MEMORY_CATEGORIES = ['preference', 'profile', 'instruction', 'project_context', 'workflow', 'other'] as const;

export const CreateMemoryDtoSchema = z.object({
  scope: z.enum(['user', 'project']),
  projectId: z.string().uuid().nullable().optional(),
  content: z.string().min(1, '内容不能为空').max(2000),
  category: z.enum(MEMORY_CATEGORIES),
  importance: z.number().int().min(0).max(100).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  status: z.enum(['candidate', 'active', 'rejected']).optional(), // 默认 candidate；手动创建可显式 active
  source: z.string().max(50).optional(),
  sourceMessageId: z.string().uuid().nullable().optional(),
});
export type CreateMemoryDto = z.infer<typeof CreateMemoryDtoSchema>;

export const UpdateMemoryDtoSchema = z.object({
  content: z.string().min(1).max(2000).optional(),
  category: z.enum(MEMORY_CATEGORIES).optional(),
  importance: z.number().int().min(0).max(100).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  status: z.enum(['candidate', 'active', 'rejected']).optional(),
});
export type UpdateMemoryDto = z.infer<typeof UpdateMemoryDtoSchema>;

/**
 * M12-P3：记忆候选人工裁决（`MemoryCandidateService.decide()` 的 HTTP 面）。
 * 只允许两个终态：`active`（提升进上下文）/ `rejected`（拒绝）——**没有** `candidate`
 * （候选已是当前态，"裁决为候选"是空操作，不该出现在写面）。
 */
export const DecideCandidateDtoSchema = z.object({
  decision: z.enum(['active', 'rejected']),
});
export type DecideCandidateDto = z.infer<typeof DecideCandidateDtoSchema>;
