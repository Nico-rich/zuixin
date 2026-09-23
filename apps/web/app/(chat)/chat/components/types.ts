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

export interface ChatStreamEventMap {
  message_start: { messageId: string; conversationId: string; createdAt: string };
  message_delta: { delta: string };
  message_end: { messageId: string; status: 'completed' | 'stopped' | 'failed' };
  status: { stage: string; message: string };
  task_created: { taskId: string; kind: 'image' | 'video' };
  error: { code: string; message: string; requestId?: string };
  agent_start: { agentId: string; runId: string };
  agent_end: { agentId: string; runId: string; status: 'completed' | 'failed' | 'cancelled' | 'timeout' };
  tool_start: { toolName: string; runId: string };
  tool_end: { toolName: string; runId: string; status: 'completed' | 'failed'; outputSummary?: string };
  run_created: { runId: string; agentId: string };
  run_progress: { runId: string; currentStep: number; maxSteps: number };
  run_completed: { runId: string; status: 'completed' | 'failed' | 'cancelled' | 'timeout' };
}
