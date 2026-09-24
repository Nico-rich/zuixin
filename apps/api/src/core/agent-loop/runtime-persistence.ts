import { TranscriptRole } from '../../modules/agent-runs/agent-run-messages.service';

/**
 * AgentRuntime 持久化边界（M6-P2）：
 * Engine 只依赖本接口，不散落 Prisma 调用——P3 resume 复用的正是这些 durable 原语。
 * 实现：PrismaRuntimePersistence（core/agent-loop/prisma-runtime-persistence.ts）。
 */
export const AGENT_RUNTIME_PERSISTENCE = 'AGENT_RUNTIME_PERSISTENCE';

export interface CreateRunInput {
  userId: string;
  agentId: string;
  agentVersionId?: string;
  projectId?: string;
  conversationId?: string;
  maxSteps: number;
  metadata?: Record<string, unknown>;
}

export interface ToolCallRecord {
  id: string;
  status: 'running' | 'completed' | 'failed';
  output: unknown | null;
}

export interface AgentRuntimePersistence {
  /** AgentRun 行创建（sync 路径 = 立即 running） */
  createRun(input: CreateRunInput): Promise<{ id: string }>;
  /** AgentRunStep 行创建（UNIQUE(runId, stepIndex) 幂等锚点） */
  createStep(data: { runId: string; stepIndex: number; type: string; status?: string; output?: unknown }): Promise<{ id: string }>;
  /** 读取系统配置（limits 等）——Engine 不直连 DB 的配置读取口 */
  getSystemSetting(key: string): Promise<Record<string, unknown> | null>;
  updateStep(stepId: string, data: { status?: string; completedAt?: Date; output?: unknown }): Promise<void>;
  /** ToolCall 先建行（running）→ 行 id 注入 ToolContext（P2 保持 M5 顺序，不实现 resume） */
  createToolCall(data: {
    runStepId: string; toolName: string; idempotencyKey: string;
    input: unknown; status?: 'running' | 'completed' | 'failed';
    output?: unknown; errorCode?: string; errorMessage?: string; completedAt?: Date | null;
  }): Promise<{ id: string }>;
  /** 幂等查重：同一 (runStepId, idempotencyKey) 已完成 → 复用输出 */
  findToolCall(runStepId: string, idempotencyKey: string): Promise<ToolCallRecord | null>;
  updateToolCall(id: string, data: { output?: unknown; status?: string; errorCode?: string; errorMessage?: string; completedAt?: Date; durationMs?: number }): Promise<void>;
  /** transcript 追加（UNIQUE(runId, sequence)，userId 首条件） */
  appendMessage(userId: string, runId: string, message: { role: TranscriptRole; content: string; toolCallId?: string; toolCalls?: unknown }): Promise<unknown>;
  /** LLM 回合用量（成功/失败每轮必记） */
  recordChatUsage(input: {
    userId: string; conversationId?: string; messageId: string; runId: string;
    providerId: string; modelId: string; inputTokens: number; outputTokens: number;
    latencyMs: number; status: 'success' | 'failed'; errorCode?: string;
  }): Promise<void>;
  /** run 终态条件更新（where status=running，禁止终态复活） */
  finalizeRun(runId: string, data: { status: string; errorCode?: string | null; errorMessage?: string | null; completedAt: Date }): Promise<{ count: number }>;
  /** currentStep 推进 */
  updateCurrentStep(runId: string, step: number): Promise<void>;
}
