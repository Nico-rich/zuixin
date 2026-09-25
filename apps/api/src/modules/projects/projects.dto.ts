import { z } from 'zod';
import { ORG_ID_REGEX } from '@ai-agent/shared';

export const CreateProjectDtoSchema = z.object({
  name: z.string().min(1, '项目名不能为空').max(100),
  description: z.string().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Pre-M9 A2：uuid 或 personal-{uuid}（个人组织 id 非纯 UUID——z.string().uuid() 会 400 拒绝合法的个人组织）
  organizationId: z.string().regex(ORG_ID_REGEX, '组织 id 格式非法').optional().nullable(),
});
export type CreateProjectDto = z.infer<typeof CreateProjectDtoSchema>;

export const UpdateProjectDtoSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type UpdateProjectDto = z.infer<typeof UpdateProjectDtoSchema>;
