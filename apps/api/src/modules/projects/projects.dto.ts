import { z } from 'zod';

export const CreateProjectDtoSchema = z.object({
  name: z.string().min(1, '项目名不能为空').max(100),
  description: z.string().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  organizationId: z.string().uuid().optional().nullable(), // M8-P1：项目必须属于组织（缺省 = 个人组织）
});
export type CreateProjectDto = z.infer<typeof CreateProjectDtoSchema>;

export const UpdateProjectDtoSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type UpdateProjectDto = z.infer<typeof UpdateProjectDtoSchema>;
