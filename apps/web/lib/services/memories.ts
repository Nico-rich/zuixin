import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Memories service（M13-F1）
 * 后端：apps/api/src/modules/memories/memories.controller.ts（JwtAuthGuard；无 GET /:id）
 *
 * 口径提示：status=candidate 的记忆**尚未生效**；人工 PATCH 是提升/降级的手段。
 * 记忆内容一律视为**不可信数据**渲染（纯文本，不解析 Markdown/HTML）。
 */
export type MemoryScope = 'user' | 'project';
export type MemoryStatus = 'candidate' | 'active' | 'rejected';
export type MemoryCategory = 'preference' | 'profile' | 'instruction' | 'project_context' | 'workflow' | 'other';

export interface Memory {
  id: string;
  userId: string;
  scope: MemoryScope;
  projectId: string | null;
  content: string;
  category: MemoryCategory;
  source: string | null;
  sourceMessageId: string | null;
  importance: number;
  confidence: number | null;
  status: MemoryStatus;
  lastUsedAt: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ListMemoriesParams {
  scope?: MemoryScope;
  projectId?: string;
  status?: MemoryStatus;
  q?: string;
}

export interface CreateMemoryInput {
  scope: MemoryScope;
  content: string;
  category: MemoryCategory;
  projectId?: string | null;
  importance?: number;
  confidence?: number | null;
  status?: MemoryStatus;
  source?: string;
  sourceMessageId?: string | null;
}

export interface UpdateMemoryInput {
  content?: string;
  category?: MemoryCategory;
  importance?: number;
  confidence?: number | null;
  status?: MemoryStatus;
}

export const memoryKeys = {
  all: ['memories'] as const,
  list: (params: ListMemoriesParams = {}) => ['memories', params] as const,
};

/** GET /api/v1/memories（take 100；importance desc, lastUsedAt desc nulls last, createdAt desc） */
export const listMemories = (params: ListMemoriesParams = {}) => {
  const qs = new URLSearchParams();
  if (params.scope) qs.set('scope', params.scope);
  if (params.projectId) qs.set('projectId', params.projectId);
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return apiFetch<{ data: Memory[] }>(`/api/v1/memories${query ? `?${query}` : ''}`);
};

/** POST /api/v1/memories */
export const createMemory = (input: CreateMemoryInput) => apiFetch<{ data: Memory }>('/api/v1/memories', jsonInit('POST', input));

/** PATCH /api/v1/memories/:id（人工提升/降级：status + 重要性/置信度） */
export const updateMemory = (id: string, input: UpdateMemoryInput) =>
  apiFetch<{ data: Memory }>(`/api/v1/memories/${id}`, jsonInit('PATCH', input));

/** DELETE /api/v1/memories/:id（硬删） */
export const deleteMemory = (id: string) => apiFetch<{ data?: unknown }>(`/api/v1/memories/${id}`, { method: 'DELETE' });
