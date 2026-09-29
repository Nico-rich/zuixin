import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Settings service（M13-F1）
 *
 * **重要事实**：后端目前**没有** `settings` 控制器（SystemSetting 表只被 Agent 运行时内部读取，
 * 无任何 HTTP 面——见 apps/api/src/core/agent-loop/prisma-runtime-persistence.ts）。
 * 因此本文件只封装「设置页当前真实可达的服务端面」：会话/设备管理（W9 的 Settings 起步面）。
 * 未来后端若开放设置端点，请在此文件追加，**不要**在前端伪造设置读写。
 */
export interface SessionSummary {
  id: string;
  deviceId: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
  /** 是否为当前会话（服务端判定） */
  current: boolean;
}

export const settingsKeys = {
  sessions: ['auth-sessions'] as const,
};

/** GET /api/v1/auth/sessions（登录设备/会话清单） */
export const listSessions = () => apiFetch<{ data: { sessions: SessionSummary[] } }>('/api/v1/auth/sessions');

/** DELETE /api/v1/auth/sessions/:id（按会话 id 下线） */
export const revokeSession = (id: string) =>
  apiFetch<{ data: { ok: true; revokedSessions: number } }>(`/api/v1/auth/sessions/${id}`, { method: 'DELETE' });

/** DELETE /api/v1/auth/sessions/device/:deviceId（按设备下线） */
export const revokeDeviceSessions = (deviceId: string) =>
  apiFetch<{ data: { ok: true; revokedSessions: number } }>(
    `/api/v1/auth/sessions/device/${encodeURIComponent(deviceId)}`, { method: 'DELETE' },
  );

/** POST /api/v1/auth/logout-all（全部下线；会清掉本机会话 cookie） */
export const logoutAll = () =>
  apiFetch<{ data: { ok: true; revokedSessions: number; blacklistedJtis: number } }>(
    '/api/v1/auth/logout-all', jsonInit('POST'),
  );

/** POST /api/v1/auth/rotate（轮换当前会话令牌） */
export const rotateSession = () =>
  apiFetch<{ data: { user: { id: string; email: string; displayName: string | null; role: string } } }>(
    '/api/v1/auth/rotate', jsonInit('POST'),
  );
