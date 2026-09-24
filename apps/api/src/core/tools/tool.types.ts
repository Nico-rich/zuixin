import { ZodSchema } from 'zod';

export type ToolPermission = 'read' | 'write' | 'generate' | 'external_action';

/**
 * Tool 执行上下文——由 AgentLoop 服务端注入，Tool 不得自行指定身份。
 * 输入 schema 禁止包含 userId/projectId/conversationId 字段（身份继承而非传参）。
 */
export interface ToolContext {
  userId: string;
  projectId?: string;
  conversationId?: string;
  messageId?: string;        // 展示锚点（生成结果附件挂到当前 assistant 消息）
  agentRunId: string;
  agentRunStepId: string;
  toolCallId: string;        // ToolCall 追溯（AgentLoop 注入，Tool 不得自定）
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface Tool {
  /** 点分命名空间，如 'image.generate' */
  name: string;
  description: string;
  inputSchema: ZodSchema;
  outputSchema?: ZodSchema;
  permission: ToolPermission;
  requiresApproval?: boolean;   // M6 审批预留；M4 全部 false
  timeoutMs?: number;
  retryPolicy?: { maxRetries: number; retryableCodes: string[] };
  execute(input: unknown, ctx: ToolContext): Promise<unknown>;
}
