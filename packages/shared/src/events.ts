import { z } from 'zod';

// ===== SSE 线上事件命名注册表（M1 定稿锁定，见架构文档 §12.2）=====
// 状态约定：
//   implemented —— 已上线，ChatStreamEventSchema 有对应 schema，前端已处理
//   reserved    —— 未来里程碑预留命名，仅锁定字符串，无 schema、无业务逻辑、前端暂不处理
// 原则：已锁定的名字永不改名（改名 = 前端协议层返工）；新事件只允许追加。
export const ChatStreamEventNames = {
  // ===== M1 已实现 =====
  message_start: 'message_start',
  message_delta: 'message_delta',
  message_end: 'message_end',
  status: 'status',
  error: 'error',
  // ===== M2~M3 预留（生图/生视频任务；schema 已就位）=====
  task_created: 'task.created',
  task_progress: 'task.progress',
  task_completed: 'task.completed',
  // 预留命名（M3 起任务失败经 task.progress + 轮询呈现；wire schema 待统一时补齐）
  task_failed: 'task.failed',
  // ===== M4~M5 预留（Agent 注册中心 / 多 Agent）=====
  agent_start: 'agent.start',
  agent_end: 'agent.end',
  // ===== M6 预留（Artifact / Tool Calling / Human Approval）=====
  artifact_created: 'artifact.created',
  tool_start: 'tool.start',
  tool_end: 'tool.end',
  approval_requested: 'approval.requested',
  // ===== M6+ 预留（长任务 Workflow / AgentRun）=====
  run_created: 'run.created',
  run_progress: 'run.progress',
  run_completed: 'run.completed',
} as const;
export type ChatStreamEventName = (typeof ChatStreamEventNames)[keyof typeof ChatStreamEventNames];

// ===== 内部 Agent 事件流（Agent 实现层，与架构文档 §7.1 一致）=====
export const StatusEventSchema = z.object({ type: z.literal('status'), stage: z.string(), message: z.string() });
export const TextDeltaEventSchema = z.object({ type: z.literal('text.delta'), text: z.string() });
export const TaskCreatedEventSchema = z.object({ type: z.literal('task.created'), taskId: z.string(), kind: z.enum(['image', 'video']) });
export const DoneEventSchema = z.object({ type: z.literal('done'), messageId: z.string(), usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional() });
export const ErrorEventSchema = z.object({ type: z.literal('error'), code: z.string(), message: z.string(), requestId: z.string().optional() });

// ===== M4: Agent / Tool / Run 事件（AgentLoop 输出，与 task.* 严格区分）=====
export const AgentStartEventSchema = z.object({ type: z.literal('agent.start'), agentId: z.string(), runId: z.string() });
export const AgentEndEventSchema = z.object({ type: z.literal('agent.end'), agentId: z.string(), runId: z.string(), status: z.enum(['completed', 'failed', 'cancelled', 'timeout']) });
export const ToolStartEventSchema = z.object({ type: z.literal('tool.start'), toolName: z.string(), runId: z.string() });
export const ToolEndEventSchema = z.object({ type: z.literal('tool.end'), toolName: z.string(), runId: z.string(), status: z.enum(['completed', 'failed']), outputSummary: z.string().optional() });
export const RunCreatedEventSchema = z.object({ type: z.literal('run.created'), runId: z.string(), agentId: z.string() });
export const RunProgressEventSchema = z.object({ type: z.literal('run.progress'), runId: z.string(), currentStep: z.number(), maxSteps: z.number() });
export const RunCompletedEventSchema = z.object({ type: z.literal('run.completed'), runId: z.string(), status: z.enum(['completed', 'failed', 'cancelled', 'timeout']) });
// M7-P1: Approval 事件（engine 产 requested；decided 由 ApprovalsService 经 EventBus 发布）
export const ApprovalRequestedEventSchema = z.object({ type: z.literal('approval.requested'), approvalId: z.string(), runId: z.string(), toolName: z.string() });
export const ApprovalDecidedEventSchema = z.object({ type: z.literal('approval.decided'), approvalId: z.string(), runId: z.string(), status: z.enum(['approved', 'rejected', 'expired', 'cancelled']) });

export const AgentEventSchema = z.discriminatedUnion('type', [
  StatusEventSchema, TextDeltaEventSchema, TaskCreatedEventSchema, DoneEventSchema, ErrorEventSchema,
  AgentStartEventSchema, AgentEndEventSchema, ToolStartEventSchema, ToolEndEventSchema,
  RunCreatedEventSchema, RunProgressEventSchema, RunCompletedEventSchema,
  ApprovalRequestedEventSchema, ApprovalDecidedEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// ===== Chat SSE 线上协议（前端消费；M2+ 追加 task.completed.artifact / tool.* 事件）=====
export const ChatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_start'), messageId: z.string(), conversationId: z.string(), role: z.enum(['assistant']), createdAt: z.string() }),
  z.object({ type: z.literal('message_delta'), delta: z.string() }),
  z.object({ type: z.literal('message_end'), messageId: z.string(), status: z.enum(['completed', 'stopped', 'failed']) }),
  z.object({ type: z.literal('status'), stage: z.string(), message: z.string() }),
  z.object({ type: z.literal('task.created'), taskId: z.string(), kind: z.enum(['image', 'video']) }),
  z.object({ type: z.literal('task.progress'), taskId: z.string(), progress: z.number(), message: z.string().optional() }),
  z.object({ type: z.literal('task.completed'), taskId: z.string(), artifact: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string(), requestId: z.string().optional() }),
  AgentStartEventSchema, AgentEndEventSchema, ToolStartEventSchema, ToolEndEventSchema,
  RunCreatedEventSchema, RunProgressEventSchema, RunCompletedEventSchema,
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;
