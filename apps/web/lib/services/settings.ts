import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Settings service（M13-F1；M13+ 追加受控设置面）
 *
 * 会话/设备管理 = 设置页基础面；`/system-settings`（M12-P4 受限写面）由**模型配置页**
 * 有意开放两个点：读 routingPolicy（默认模型展示）与 PATCH routingPolicy（默认模型选择）
 * ——除此之外的受控键**仍然无 Web 入口**（绝不在前端伪造设置读写）。
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

export const systemSettingKeys = {
  detail: (key: string) => ['system-setting', key] as const,
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

// ===== M13+ 受控设置面（模型配置页的默认模型读写；平台管理员）=====

export interface SystemSettingView {
  key: string;
  description: string;
  value: unknown;
  readOnlySubKeys: readonly string[];
  updatedAt: string | null;
}

/** GET /api/v1/system-settings/:key（平台管理员；受控键白名单投影） */
export const getSystemSetting = (key: string) =>
  apiFetch<{ data: SystemSettingView }>(`/api/v1/system-settings/${encodeURIComponent(key)}`);

/** PATCH /api/v1/system-settings/:key（平台管理员；白名单内子键深合并 + 强制审计） */
export const patchSystemSetting = (key: string, value: unknown) =>
  apiFetch<{ data: SystemSettingView }>(`/api/v1/system-settings/${encodeURIComponent(key)}`, jsonInit('PATCH', value));
