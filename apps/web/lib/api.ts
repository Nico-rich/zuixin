export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly requestId?: string) { super(message); this.name = 'ApiError'; }
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

let refreshing: Promise<boolean> | null = null;

/** 统一 API 客户端：cookie 凭据 + CSRF 头 + 401 自动刷新重试 + 错误归一化 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const doFetch = () => fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...XRW, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });

  let res = await doFetch();
  if (res.status === 401 && !path.startsWith('/auth/')) {
    refreshing ??= fetch(`${API_BASE}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include', headers: XRW })
      .then((r) => r.ok).finally(() => { refreshing = null; });
    if (await refreshing) res = await doFetch();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error?.code ?? 'INTERNAL', body?.error?.message ?? '请求失败', body?.error?.requestId);
  }
  return res.json() as Promise<T>;
}

export { API_BASE };
