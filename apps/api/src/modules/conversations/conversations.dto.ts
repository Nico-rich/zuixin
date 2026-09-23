import { z } from 'zod';

export const CreateConversationDtoSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  projectId: z.string().uuid().nullable().optional(),
});
export type CreateConversationDto = z.infer<typeof CreateConversationDtoSchema>;

export const UpdateConversationDtoSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  projectId: z.string().uuid().nullable().optional(), // null = 移出项目
});
export type UpdateConversationDto = z.infer<typeof UpdateConversationDtoSchema>;
