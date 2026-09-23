import { z } from 'zod';

// SSE 事件协议（与架构文档 §12.2 一致；M1 起接线 chat 流）
export const StatusEventSchema = z.object({ type: z.literal('status'), stage: z.string(), message: z.string() });
export const TextDeltaEventSchema = z.object({ type: z.literal('text.delta'), text: z.string() });
export const TaskCreatedEventSchema = z.object({ type: z.literal('task.created'), taskId: z.string(), kind: z.enum(['image', 'video']) });
export const DoneEventSchema = z.object({ type: z.literal('done'), messageId: z.string() });
export const ErrorEventSchema = z.object({ type: z.literal('error'), code: z.string(), message: z.string(), requestId: z.string().optional() });

export const AgentEventSchema = z.discriminatedUnion('type', [
  StatusEventSchema, TextDeltaEventSchema, TaskCreatedEventSchema, DoneEventSchema, ErrorEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
