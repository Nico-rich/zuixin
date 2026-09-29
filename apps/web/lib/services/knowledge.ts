import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Knowledge service（M13-F1）
 * 后端：apps/api/src/modules/knowledge/knowledge.controller.ts（JwtAuthGuard）
 * 摄入是**同步**的（POST documents 返回时已切块/向量化），页面据此决定 loading 文案。
 */
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface KnowledgeDocument {
  id: string;
  kbId: string | null;
  userId: string;
  projectId: string | null;
  name: string;
  sourceType: 'text' | 'file';
  content: string | null;
  sourceUri: string | null;
  storageKey: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  contentHash: string | null;
  status: DocumentStatus;
  errorCode: string | null;
  chunkCount: number;
  version: number;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDocumentInput {
  name: string;
  sourceType: 'text' | 'file';
  projectId?: string;
  content?: string;
  attachmentId?: string;
}

export const knowledgeKeys = {
  all: ['knowledge-documents'] as const,
  list: (projectId?: string) => ['knowledge-documents', projectId ?? null] as const,
  detail: (id: string) => ['knowledge-document', id] as const,
};

/** GET /api/v1/knowledge/documents?projectId=（take 100，createdAt desc，无分页） */
export const listDocuments = (projectId?: string) =>
  apiFetch<{ data: KnowledgeDocument[] }>(`/api/v1/knowledge/documents${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);

/** POST /api/v1/knowledge/documents（同步摄入：text 传 content，file 传 attachmentId） */
export const createDocument = (input: CreateDocumentInput) =>
  apiFetch<{ data: KnowledgeDocument }>('/api/v1/knowledge/documents', jsonInit('POST', input));

/** GET /api/v1/knowledge/documents/:id */
export const getDocument = (id: string) => apiFetch<{ data: KnowledgeDocument }>(`/api/v1/knowledge/documents/${id}`);

/** POST /api/v1/knowledge/documents/:id/reindex */
export const reindexDocument = (id: string) =>
  apiFetch<{ data: KnowledgeDocument }>(`/api/v1/knowledge/documents/${id}/reindex`, jsonInit('POST'));

/** DELETE /api/v1/knowledge/documents/:id（硬删，chunks 级联） */
export const deleteDocument = (id: string) =>
  apiFetch<{ data?: unknown }>(`/api/v1/knowledge/documents/${id}`, { method: 'DELETE' });
