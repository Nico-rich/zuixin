import { z } from 'zod';

/** POST /agent-runs（M6-P3 异步入口）：身份由 JWT 注入，客户端不可指定 userId/agentVersionId */
export const CreateAgentRunSchema = z.object({
  agentId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  message: z.string().min(1).max(20000),
});
export type CreateAgentRunDto = z.infer<typeof CreateAgentRunSchema>;
