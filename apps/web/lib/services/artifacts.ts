import { apiFetch } from '@/lib/api';

/**
 * Artifacts service（M13-W9）
 * 后端：apps/api/src/modules/artifacts/artifacts.controller.ts（只读面：列表/详情/下载）
 *
 * **闭环断裂修复之二**：Artifacts 此前只有 service、没有 HTTP 面 → 制品在 Web 上完全不可见。
 * 现在只有 **GET** 三个端点，**没有任何写端点**：
 *  - 制品的唯一写路径是 Agent 工具（`artifact.create`）经 ToolCall 幂等账本落库——"工具即接口"；
 *  - 因此本文件只有读函数，页面也**不得**提供"新建/编辑制品"的入口。
 *
 * 两条服务端红线（前端不得绕过、也不得伪造替代口径）：
 *  - 归属：`userId` 只由 JWT 决定，列表/详情/下载一律服务端过滤；
 *  - 投影：`storageKey` / `idempotencyKey` 等内部列不在响应里；文件下载只能走 `downloadUrl`
 *    （服务端代理 + 归属校验 + `attachment` 强制下载，字节属 UNTRUSTED，绝不 inline 渲染）。
 */

export const ARTIFACT_TYPES = ['creative_brief', 'image', 'video', 'report', 'analysis', 'other'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type ArtifactStatus = 'draft' | 'ready' | 'failed';

/** 列表项（列表端点不返回 `content` 证据体——正文只在详情端点） */
export interface ArtifactListItem {
  id: string;
  type: ArtifactType;
  title: string;
  summary: string | null;
  content: null;
  status: ArtifactStatus;
  projectId: string | null;
  conversationId: string | null;
  messageId: string | null;
  taskId: string | null;
  runId: string | null;
  toolCallId: string | null;
  createdAt: string;
  updatedAt: string;
  /** 非空 = 有落库文件（走服务端代理下载）；null = 纯结构化制品 */
  downloadUrl: string | null;
}

/** 详情（含 `content` 正文：图片/报告/分析的结构化载荷） */
export interface ArtifactDetail extends Omit<ArtifactListItem, 'content'> {
  content: unknown;
}

export const artifactKeys = {
  list: (type: ArtifactType | 'all' = 'all') => ['artifacts', type] as const,
  detail: (id: string) => ['artifact', id] as const,
};

/** GET /api/v1/artifacts（服务端按 JWT 归属过滤；type 为唯一筛选维度） */
export function listArtifacts(params: { type?: ArtifactType; limit?: number } = {}) {
  const q = new URLSearchParams();
  if (params.type) q.set('type', params.type);
  if (params.limit) q.set('limit', String(params.limit));
  const suffix = q.toString();
  return apiFetch<{ data: ArtifactListItem[] }>(`/api/v1/artifacts${suffix ? `?${suffix}` : ''}`);
}

/** GET /api/v1/artifacts/:id（他人/不存在一律 404，前端不区分） */
export function getArtifact(id: string) {
  return apiFetch<{ data: ArtifactDetail }>(`/api/v1/artifacts/${encodeURIComponent(id)}`);
}

/** 下载链接（`<a href>` 同源直连；服务端代理 + attachment 头，前端不做任何拼接/预签名） */
export function artifactDownloadPath(id: string): string {
  return `/api/v1/artifacts/${encodeURIComponent(id)}/download`;
}
