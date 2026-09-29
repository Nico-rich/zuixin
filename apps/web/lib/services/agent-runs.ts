import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Agent Runs service（M13-F1）
 * 后端：apps/api/src/modules/agent-runs/agent-runs.controller.ts（JwtAuthGuard）
 *
 * 注意两点：
 *  - `GET /agent-runs` 的 `conversationId` 是**必填**（缺失 → 400 VALIDATION_ERROR）；
 *  - 时间线的权威渲染组件是既有 `app/(chat)/chat/components/run-timeline.tsx`（Timeline 是投影，不是事实源）。
 */
export type AgentRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface AgentRun {
  id: string;
  userId: string;
  agentId: string;
  agentVersionId: string | null;
  projectId: string | null;
  conversationId: string | null;
  status: AgentRunStatus;
  currentStep: number;
  maxSteps: number;
  errorCode: string | null;
  errorMessage: string | null;
  metadata: unknown;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  attempt: number;
  retryOfRunId: string | null;
  parentRunId: string | null;
  agent?: { slug: string; name: string };
}

export interface AgentRunStep {
  id: string;
  runId: string;
  stepIndex: number;
  type: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  runId: string;
  name: string;
  status: string;
  input: unknown;
  output: unknown;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AgentRunDetail extends AgentRun {
  steps: AgentRunStep[];
  agent: { id: string; slug: string; name: string };
  agentVersion: { id: string; version: number; status: string } | null;
  tasks: unknown[];
  artifacts: unknown[];
}

/** 时间线条目（与 apps/api/src/modules/agent-runs/timeline.types.ts 对齐；web 侧把 type/status 放宽为 string） */
export interface TimelineItem {
  id: string;
  type: string;
  status: 'success' | 'failed' | 'running' | 'info';
  timestamp: string;
  title: string;
  summary?: string;
  durationMs?: number;
  metadata?: unknown;
}

export interface RunUsageAggregate {
  runId: string;
  durationMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  llmCost: number;
  imageCost: number;
  videoCost: number;
  totalCost: number;
  llmRounds: number;
  imageCount: number;
  videoSeconds: number;
  failedCalls: number;
  byKind: Array<{ kind: string; count: number; cost: number; tokens: number }>;
}

export interface RunTimeline {
  runId: string;
  agentId: string;
  agentName: string;
  agentVersion: number;
  status: AgentRunStatus;
  startedAt: string;
  completedAt: string | null;
  items: TimelineItem[];
  usage: RunUsageAggregate | null;
}

export interface StartAgentRunInput {
  message: string;
  agentId?: string;
  conversationId?: string | null;
  projectId?: string | null;
}

export const agentRunKeys = {
  all: ['agent-runs'] as const,
  list: (conversationId: string) => ['agent-runs', conversationId] as const,
  detail: (id: string) => ['agent-run', id] as const,
  timeline: (id: string) => ['agent-run-timeline', id] as const,
};

/** GET /api/v1/agent-runs?conversationId=…（conversationId 必填；take 20，createdAt desc） */
export const listAgentRuns = (conversationId: string) =>
  apiFetch<{ data: AgentRun[] }>(`/api/v1/agent-runs?conversationId=${encodeURIComponent(conversationId)}`);

/** GET /api/v1/agent-runs/:id（含 steps/toolCalls/tasks/artifacts 血缘） */
export const getAgentRun = (id: string) => apiFetch<{ data: AgentRunDetail }>(`/api/v1/agent-runs/${id}`);

/** POST /api/v1/agent-runs（异步执行；201 + { runId, status:'queued' }；限流 300/min） */
export const startAgentRun = (input: StartAgentRunInput) =>
  apiFetch<{ data: { runId: string; status: 'queued' } }>('/api/v1/agent-runs', jsonInit('POST', input));

/** POST /api/v1/agent-runs/:id/cancel（已终态 → 409） */
export const cancelAgentRun = (id: string) =>
  apiFetch<{ data: { runId: string; status: 'cancelled' } }>(`/api/v1/agent-runs/${id}/cancel`, jsonInit('POST'));

/** POST /api/v1/agent-runs/:id/retry（非终态 → 409） */
export const retryAgentRun = (id: string) =>
  apiFetch<{ data: { runId: string; status: AgentRunStatus; attempt: number; retryOfRunId: string } }>(
    `/api/v1/agent-runs/${id}/retry`, jsonInit('POST'),
  );

/** GET /api/v1/agent-runs/:id/timeline（= RunTimeline 投影 + usage 聚合） */
export const getRunTimeline = (id: string) => apiFetch<{ data: RunTimeline }>(`/api/v1/agent-runs/${id}/timeline`);

/**
 * GET /api/v1/agent-runs/:id/events 的 SSE 端点（**不要**用 apiFetch：非 JSON 信封）。
 * 页面需要实时事件时用 fetch + `lib/sse.ts` 的 consumeSSE，并在请求头带 X-Requested-With。
 */
export const RUN_EVENTS_PATH = (id: string) => `/api/v1/agent-runs/${id}/events`;
