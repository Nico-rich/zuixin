import {
  useMutation, useQuery, useQueryClient,
  type QueryClient, type QueryKey, type UseMutationOptions, type UseMutationResult,
  type UseQueryOptions, type UseQueryResult,
} from '@tanstack/react-query';

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

/* ------------------------------------------------------------------ *
 * react-query 封装（M13-F1）
 *
 * 原则：**不改变既有默认策略**。providers.tsx 已设 `retry:false / refetchOnWindowFocus:false / staleTime:30s`，
 * 这里不再覆盖，只把「path → apiFetch」这一段固定下来，保证：
 *   ① 所有请求都走同一个客户端（cookie 凭据 + CSRF 头 + 401 自动续期重试）；
 *   ② 错误类型统一收窄为 ApiError（页面 `error.code` 可直接分支）；
 *   ③ queryKey 由调用方显式给出（不自动由 path 推导——避免查询键与失效调用脱节）。
 * ------------------------------------------------------------------ */

export interface ApiQueryOptions<TData> extends Omit<UseQueryOptions<TData, ApiError, TData, QueryKey>, 'queryKey' | 'queryFn'> {
  queryKey: QueryKey;
  /** 同源相对路径（如 `/api/v1/projects`）；不要带 API_BASE */
  path: string;
  /** 附加的 fetch 参数（method/body/headers）；abort signal 由 react-query 注入并覆盖 */
  init?: RequestInit;
}

/**
 * `useQuery` + `apiFetch` 的组合封装。
 * 禁用查询请用 `enabled: false`（path 为静态字符串即可，无需造条件 path）。
 */
export function useApiQuery<TData>({ queryKey, path, init, ...options }: ApiQueryOptions<TData>): UseQueryResult<TData, ApiError> {
  return useQuery<TData, ApiError, TData, QueryKey>({
    queryKey,
    queryFn: ({ signal }) => apiFetch<TData>(path, { ...init, signal }),
    ...options,
  });
}

/**
 * `useMutation` + 既有 service 函数（或任意返回 ApiError 的异步操作）的组合封装。
 * 默认 `retry:false`（与 providers.tsx 一致）；错误类型收窄为 ApiError。
 */
export function useApiMutation<TData, TVariables = void>(
  operation: (variables: TVariables) => Promise<TData>,
  options?: Omit<UseMutationOptions<TData, ApiError, TVariables>, 'mutationFn'>,
): UseMutationResult<TData, ApiError, TVariables> {
  return useMutation<TData, ApiError, TVariables>({ mutationFn: operation, retry: false, ...options });
}

/** 取 QueryClient（页面做失效/乐观更新时用；等价于 useQueryClient，仅为减少 import 面） */
export function useApiQueryClient(): QueryClient {
  return useQueryClient();
}

/** 只对「网络/服务端」故障重试的判定：4xx 业务错误（鉴权/校验/冲突/限流）一律不重试 */
export function apiRetryPolicy(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError) return false;
  return failureCount < 2;
}

/** JSON 写请求的 request init 构造（省掉每处 JSON.stringify + Content-Type 的重复） */
export function jsonInit(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown): RequestInit {
  return body === undefined ? { method } : { method, body: JSON.stringify(body) };
}

/** 从分页响应头解析游标元信息（conversations/messages 用 X-Page-* 头，不在 body 里） */
export interface PageMeta {
  limit: number | null;
  hasMore: boolean;
  order: string | null;
  nextCursor: string | null;
  prevCursor: string | null;
}

export function pageMetaFromHeaders(headers: Headers): PageMeta {
  return {
    limit: headers.get('X-Page-Limit') ? Number(headers.get('X-Page-Limit')) : null,
    hasMore: headers.get('X-Page-Has-More') === 'true',
    order: headers.get('X-Page-Order'),
    nextCursor: headers.get('X-Page-Next-Cursor'),
    prevCursor: headers.get('X-Page-Prev-Cursor'),
  };
}

/**
 * 带响应头的请求（分页元信息只在头里）。
 *
 * 返回 `{ data, meta, body }`：
 *  - `data` 是**已拆信封**的业务载荷（后端 TransformInterceptor 一律返回 `{ data: … }`），
 *    故 `apiFetchWithMeta<Conversation[]>(…)` 的 `data` 就是数组本身——与 `apiFetch<T>`
 *    的 `T = 整个响应体` 口径**不同**，这里刻意拆开，避免调用方写 `res.data.data`；
 *  - `meta` 来自 X-Page-* 响应头（body 里没有分页信息）；
 *  - `body` 是原始响应体（逃生口：万一将来 body 里出现信封之外的字段，不会被静默丢掉）。
 *
 * 错误归一化与 apiFetch 一致（含 401 续期重试）。
 */
export interface ApiMetaResult<T> { data: T; meta: PageMeta; body: unknown }

export async function apiFetchWithMeta<T>(path: string, init: RequestInit = {}): Promise<ApiMetaResult<T>> {
  const doFetch = () => fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
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
  const body: unknown = await res.json();
  const data = (body !== null && typeof body === 'object' && 'data' in body ? (body as { data: T }).data : body) as T;
  return { data, meta: pageMetaFromHeaders(res.headers), body };
}

export { API_BASE };
