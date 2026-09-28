export interface AttachmentView {
  id: string;
  kind: 'upload' | 'generated_image' | 'generated_video' | 'generated_file';
  type: 'image' | 'video' | 'file';
  mimeType: string;
  originalName?: string | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  errorCode?: string | null;
  createdAt?: string;
  attachments?: AttachmentView[];
}

export interface ConversationItem { id: string; title: string; updatedAt: string; projectId?: string | null; }

export interface ProjectItem { id: string; name: string; updatedAt: string; }

export interface ActiveTask { taskId: string; kind: 'image' | 'video'; }

export interface TimelineItem {
  id: string;
  type: string;
  status: 'success' | 'failed' | 'running' | 'info';
  timestamp: string;
  title: string;
  summary?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface RunTimelineUsage {
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
  status: string;
  startedAt: string;
  completedAt: string | null;
  items: TimelineItem[];
  usage: RunTimelineUsage | null;
}

export interface ChatStreamEventMap {
  message_start: { messageId: string; conversationId: string; createdAt: string };
  message_delta: { delta: string };
  message_end: { messageId: string; status: 'completed' | 'stopped' | 'failed' };
  status: { stage: string; message: string };
  task_created: { taskId: string; kind: 'image' | 'video' };
  // M10-P13（ARCH-07）：worker → Redis `task` 通道 → api SSE 转发器 → 本页 SSE 流
  task_progress: { taskId: string; progress: number; message?: string };
  task_completed: { taskId: string };
  error: { code: string; message: string; requestId?: string };
  agent_start: { agentId: string; runId: string };
  agent_end: { agentId: string; runId: string; status: 'completed' | 'failed' | 'cancelled' | 'timeout' };
  tool_start: { toolName: string; runId: string };
  tool_end: { toolName: string; runId: string; status: 'completed' | 'failed'; outputSummary?: string };
  run_created: { runId: string; agentId: string };
  run_progress: { runId: string; currentStep: number; maxSteps: number };
  run_completed: { runId: string; status: 'completed' | 'failed' | 'cancelled' | 'timeout' };
}
