export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  errorCode?: string | null;
  createdAt?: string;
}

export interface ConversationItem { id: string; title: string; updatedAt: string; }

export interface ChatStreamEventMap {
  message_start: { messageId: string; conversationId: string; createdAt: string };
  message_delta: { delta: string };
  message_end: { messageId: string; status: 'completed' | 'stopped' | 'failed' };
  status: { stage: string; message: string };
  error: { code: string; message: string; requestId?: string };
}
