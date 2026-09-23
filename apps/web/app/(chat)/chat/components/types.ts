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
}
