import { z } from 'zod';

export const ChatDtoSchema = z.object({
  conversationId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(), // 自动建会话时挂载项目
  attachmentIds: z.array(z.string().uuid()).max(10).optional(), // M2-7 附件上传接线
  message: z.string().min(1, '消息不能为空').max(20000),
});
export type ChatDto = z.infer<typeof ChatDtoSchema>;
