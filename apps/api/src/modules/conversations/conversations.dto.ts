import { z } from 'zod';

export const CreateConversationDtoSchema = z.object({ title: z.string().min(1).max(100).optional() });
export type CreateConversationDto = z.infer<typeof CreateConversationDtoSchema>;

export const UpdateConversationDtoSchema = z.object({ title: z.string().min(1).max(100) });
export type UpdateConversationDto = z.infer<typeof UpdateConversationDtoSchema>;
