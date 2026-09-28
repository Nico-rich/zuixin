import { z } from 'zod';

export const ChatDtoSchema = z.object({
  conversationId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(), // 自动建会话时挂载项目
  attachmentIds: z.array(z.string().uuid()).max(10).optional(), // M2-7 附件上传接线
  message: z.string().min(1, '消息不能为空').max(20000),
});
export type ChatDto = z.infer<typeof ChatDtoSchema>;

/**
 * M10-P3 消息编辑请求体：**只允许改 content**。
 * 长度上限与发消息（ChatDtoSchema.message）同源 = 20000 —— 编辑不能成为绕过发送上限的
 * 后门（否则可把超长内容写进消息与摘要提炼输入）。role/userId/conversationId 一律不可改：
 * 请求体里出现也被 zod 丢弃（白名单式解析），改归属只能通过所有权校验后的服务端路径。
 */
export const EditMessageDtoSchema = z.object({
  content: z.string().min(1, '消息不能为空').max(20000),
});
export type EditMessageDto = z.infer<typeof EditMessageDtoSchema>;
