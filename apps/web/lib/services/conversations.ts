import { apiFetch, apiFetchWithMeta, jsonInit, type PageMeta } from '@/lib/api';

/**
 * Conversations service（M13-F1）
 * 后端：apps/api/src/modules/conversations/conversations.controller.ts
 *
 * **分页元信息在响应头**（X-Page-Limit / X-Page-Has-More / X-Page-Order / X-Page-Next-Cursor /
 * X-Page-Prev-Cursor），不在 body → 列表函数用 apiFetchWithMeta 并把 meta 一并返回。
 */
export interface Conversation {
  id: string;
  title: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessageAttachment {
  id: string;
  kind: string;
  type: string;
  mimeType: string;
  originalName: string | null;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  status: 'streaming' | 'completed' | 'failed' | 'cancelled';
  errorCode: string | null;
  intentType: string | null;
  intentConfidence: number | null;
  createdAt: string;
  editedAt: string | null;
  attachments: ConversationMessageAttachment[];
}

export interface ListConversationsParams {
  projectId?: string;
  limit?: number;
  before?: string;
  after?: string;
}

export const conversationKeys = {
  all: ['conversations'] as const,
  list: (projectId?: string | null) => ['conversations', projectId ?? null] as const,
  detail: (id: string) => ['conversation', id] as const,
  /** 与既有 chat-workspace 一致：['messages', conversationId] */
  messages: (conversationId: string | undefined) => ['messages', conversationId] as const,
};

/** GET /api/v1/conversations（游标分页；before/after 互斥） */
export function listConversations(params: ListConversationsParams = {}): Promise<{ data: Conversation[]; meta: PageMeta }> {
  const qs = new URLSearchParams();
  if (params.projectId) qs.set('projectId', params.projectId);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.before) qs.set('before', params.before);
  if (params.after) qs.set('after', params.after);
  const query = qs.toString();
  return apiFetchWithMeta<Conversation[]>(`/api/v1/conversations${query ? `?${query}` : ''}`);
}

/** POST /api/v1/conversations */
export const createConversation = (input: { title?: string; projectId?: string | null } = {}) =>
  apiFetch<{ data: Conversation }>('/api/v1/conversations', jsonInit('POST', input));

/** GET /api/v1/conversations/:id */
export const getConversation = (id: string) => apiFetch<{ data: Conversation }>(`/api/v1/conversations/${id}`);

/** PATCH /api/v1/conversations/:id（重命名 / 移动项目） */
export const updateConversation = (id: string, input: { title?: string; projectId?: string | null }) =>
  apiFetch<{ data: Conversation }>(`/api/v1/conversations/${id}`, jsonInit('PATCH', input));

/** DELETE /api/v1/conversations/:id（软删） */
export const deleteConversation = (id: string) => apiFetch<{ data?: unknown }>(`/api/v1/conversations/${id}`, { method: 'DELETE' });

/** GET /api/v1/conversations/:id/messages（游标分页，默认 limit 200，createdAt asc） */
export function listConversationMessages(
  id: string,
  params: { limit?: number; before?: string; after?: string } = {},
): Promise<{ data: ConversationMessage[]; meta: PageMeta }> {
  const qs = new URLSearchParams();
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.before) qs.set('before', params.before);
  if (params.after) qs.set('after', params.after);
  const query = qs.toString();
  return apiFetchWithMeta<ConversationMessage[]>(`/api/v1/conversations/${id}/messages${query ? `?${query}` : ''}`);
}
