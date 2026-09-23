export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly requestId?: string) { super(message); this.name = 'ApiError'; }
}

// 默认同源（Next rewrites 代理 /api → 后端）；生产可由 NEXT_PUBLIC_API_URL 覆盖
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

let refreshing: Promise<boolean> | null = null;

/** 统一 API 客户端：cookie 凭据 + CSRF 头 + 401 自动刷新重试 + 错误归一化 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const doFetch = () => fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    // FormData 由浏览器自动带 boundary，不能手动设置 Content-Type
    headers: { ...XRW, ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
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

/** 上传附件（multipart） */
export async function uploadAttachment(file: File): Promise<{ data: { id: string; type: string; mimeType: string } }> {
  const form = new FormData();
  form.append('file', file);
  return apiFetch('/api/v1/attachments', { method: 'POST', body: form });
}

export { API_BASE };
