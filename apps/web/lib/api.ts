export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly requestId?: string) { super(message); this.name = 'ApiError'; }
}

// 默认同源（Next rewrites 代理 /api → 后端）；生产可由 NEXT_PUBLIC_API_URL 覆盖
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

let refreshing: Promise<boolean> | null = null;

/** 鉴权控制器真实前缀（api 全局前缀 api/v1 + auth 控制器）；refresh 自身也在此前缀下 */
const AUTH_PREFIX = '/api/v1/auth';
const REFRESH_PATH = `${AUTH_PREFIX}/refresh`;

/**
 * 是否命中鉴权端点自身（login/refresh/logout/me…）。
 *
 * M10-P13（审计 M9-17）修复：原守卫写作 `!path.startsWith('/auth/')`，与实际路径 `/api/v1/auth/*`
 * 不匹配 → 恒为 true（死条件），auth 端点自身的 401 也会额外打一次 `/auth/refresh`
 * （refresh 失败时纯属多一次无效往返；refresh 本身 401 还会被再刷新一次）。
 * 这里按**真实路径**前缀判断，并容忍 `?query`、调用方传入带 API_BASE 的绝对路径。
 */
export function isAuthEndpoint(path: string): boolean {
  const clean = path.split(/[?#]/)[0];
  const relative = API_BASE && clean.startsWith(API_BASE) ? clean.slice(API_BASE.length) : clean;
  const normalized = relative.startsWith('/') ? relative : `/${relative}`;
  return normalized === AUTH_PREFIX || normalized.startsWith(`${AUTH_PREFIX}/`);
}

/** 统一 API 客户端：cookie 凭据 + CSRF 头 + 401 自动刷新重试 + 错误归一化 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const doFetch = () => fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    // FormData 由浏览器自动带 boundary，不能手动设置 Content-Type
    headers: { ...XRW, ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });

  let res = await doFetch();
  if (res.status === 401 && !isAuthEndpoint(path)) {
    refreshing ??= fetch(`${API_BASE}${REFRESH_PATH}`, { method: 'POST', credentials: 'include', headers: XRW })
      .then((r) => r.ok).finally(() => { refreshing = null; });
    if (await refreshing) res = await doFetch();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error?.code ?? 'INTERNAL', body?.error?.message ?? '请求失败', body?.error?.requestId);
  }
  return res.json() as Promise<T>;
}

/** 上传附件（multipart） */
export async function uploadAttachment(file: File): Promise<{ data: { id: string; type: string; mimeType: string } }> {
  const form = new FormData();
  form.append('file', file);
  return apiFetch('/api/v1/attachments', { method: 'POST', body: form });
}

export { API_BASE };
