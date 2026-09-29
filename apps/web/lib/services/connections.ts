import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Connections service（M13-F1）
 * 后端：apps/api/src/modules/connections/connections.controller.ts（JwtAuthGuard）
 *
 * **红线**：后端返回的连接视图是 CONNECTION_SELECT —— 永不包含凭证（token/secret）。
 * 页面也不得展示/请求任何凭证字段；OAuth 授权走 `start` 返回的 authorizeUrl（前端只做跳转）。
 */
export interface ConnectionView {
  id: string;
  userId: string;
  projectId: string | null;
  provider: string;
  providerAccountId: string | null;
  status: 'active' | 'expired' | 'revoked';
  scope: unknown;
  expiresAt: string | null;
  revokedAt: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const connectionKeys = {
  all: ['connections'] as const,
  list: (provider?: string) => ['connections', provider ?? null] as const,
  detail: (id: string) => ['connection', id] as const,
};

/** GET /api/v1/connections?provider=（createdAt desc，无分页） */
export const listConnections = (provider?: string) =>
  apiFetch<{ data: ConnectionView[] }>(`/api/v1/connections${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`);

/** GET /api/v1/connections/:id */
export const getConnection = (id: string) => apiFetch<{ data: ConnectionView }>(`/api/v1/connections/${id}`);

/** POST /api/v1/connections/:provider/start（限流 30/min）→ 前端跳转 authorizeUrl */
export const startConnection = (provider: string, input: { projectId?: string | null } = {}) =>
  apiFetch<{ data: { authorizeUrl: string; state: string } }>(
    `/api/v1/connections/${encodeURIComponent(provider)}/start`, jsonInit('POST', input),
  );

/** GET /api/v1/connections/:provider/callback（通常由后端/浏览器回调直接命中，前端一般不手动调） */
export const completeConnection = (provider: string, params: { state: string; code: string }) =>
  apiFetch<{ data: ConnectionView }>(
    `/api/v1/connections/${encodeURIComponent(provider)}/callback?state=${encodeURIComponent(params.state)}&code=${encodeURIComponent(params.code)}`,
  );

/** POST /api/v1/connections/:id/refresh（已撤销 → 409） */
export const refreshConnection = (id: string) =>
  apiFetch<{ data: ConnectionView }>(`/api/v1/connections/${id}/refresh`, jsonInit('POST'));

/** POST /api/v1/connections/:id/revoke（已撤销 → 409） */
export const revokeConnection = (id: string) =>
  apiFetch<{ data: ConnectionView }>(`/api/v1/connections/${id}/revoke`, jsonInit('POST'));

/** DELETE /api/v1/connections/:id */
export const deleteConnection = (id: string) =>
  apiFetch<{ data: { deleted: true } }>(`/api/v1/connections/${id}`, { method: 'DELETE' });
