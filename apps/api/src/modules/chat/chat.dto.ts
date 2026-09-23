import { z } from 'zod';

export const ChatDtoSchema = z.object({
  conversationId: z.string().uuid().nullable().optional(),
  message: z.string().min(1, '消息不能为空').max(20000),
});
export type ChatDto = z.infer<typeof ChatDtoSchema>;
