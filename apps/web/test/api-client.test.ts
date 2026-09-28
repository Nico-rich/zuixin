import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, isAuthEndpoint, uploadAttachment } from '@/lib/api';
import { jsonResponse } from './helpers';

type FetchCall = [RequestInfo | URL, RequestInit | undefined];
const url = (call: FetchCall) => String(call[0]);

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe('apiFetch 鉴权与错误归一化', () => {
  it('401 → 先调 refresh 再重放原请求（cookie 凭据 + CSRF 头 + 重放后返回数据）', async () => {
    const calls: FetchCall[] = [];
    const mock = stubFetch((u, init) => {
      calls.push([u, init]);
      if (u.endsWith('/api/v1/auth/refresh')) return jsonResponse({ data: { ok: true } });
      return mock.mock.calls.filter((c) => url(c as FetchCall) === u).length === 1
        ? jsonResponse({ error: { code: 'UNAUTHORIZED', message: '登录已过期' } }, 401)
        : jsonResponse({ data: { id: 'conv-1' } });
    });

    await expect(apiFetch<{ data: { id: string } }>('/api/v1/conversations/conv-1')).resolves.toEqual({ data: { id: 'conv-1' } });
    expect(mock).toHaveBeenCalledTimes(3);
    expect(url(calls[1])).toBe('/api/v1/auth/refresh');
    expect(calls[1][1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect((calls[1][1]!.headers as Record<string, string>)['X-Requested-With']).toBe('XMLHttpRequest');
    expect(calls[0][1]).toMatchObject({ credentials: 'include' });
  });

  it('并发多个 401 只触发一次 refresh（in-flight 折叠）', async () => {
    let refreshCount = 0;
    const firstHit = new Set<string>();
    const mock = stubFetch(async (u) => {
      if (u.endsWith('/api/v1/auth/refresh')) {
        refreshCount += 1;
        await new Promise((r) => setTimeout(r, 10)); // 模拟网络往返，保证两次 401 重叠
        return jsonResponse({ data: { ok: true } });
      }
      if (!firstHit.has(u)) { firstHit.add(u); return jsonResponse({ error: { code: 'UNAUTHORIZED', message: '过期' } }, 401); }
      return jsonResponse({ data: { path: u } });
    });

    const [a, b] = await Promise.all([apiFetch<{ data: unknown }>('/api/v1/a'), apiFetch<{ data: unknown }>('/api/v1/b')]);
    expect(a).toEqual({ data: { path: '/api/v1/a' } });
    expect(b).toEqual({ data: { path: '/api/v1/b' } });
    expect(refreshCount).toBe(1);
    expect(mock).toHaveBeenCalledTimes(5); // 2 次原始 401 + 1 次 refresh + 2 次重放
  });

  // M10-P13（审计 M9-17）修复：守卫原写作 `!path.startsWith('/auth/')`，与真实路径 `/api/v1/auth/*`
  // 不匹配 → 死条件（auth 端点自身 401 也会多打一次 refresh）。现按真实前缀判断。
  it('auth 端点自身 401 → 不触发 refresh，直接抛原始 ApiError（只 1 次请求）', async () => {
    const mock = stubFetch(() => jsonResponse({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, 401));
    await expect(apiFetch('/api/v1/auth/me')).rejects.toMatchObject({ name: 'ApiError', code: 'UNAUTHORIZED', message: '未登录' });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(url(mock.mock.calls[0] as FetchCall)).toBe('/api/v1/auth/me');
  });

  it('兄弟端点 /api/v1/auth/login 与 /api/v1/auth 本身同样被守卫（不触发 refresh）', async () => {
    const mock = stubFetch(() => jsonResponse({ error: { code: 'UNAUTHORIZED', message: '凭据无效' } }, 401));
    await expect(apiFetch('/api/v1/auth/login', { method: 'POST' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(apiFetch('/api/v1/auth')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mock.mock.calls.map((c) => url(c as FetchCall))).toEqual(['/api/v1/auth/login', '/api/v1/auth']);
  });

  it('前缀相似但非 auth 的路径（/api/v1/authx/*）不误判 → 仍走 refresh 重试', async () => {
    const mock = stubFetch((u) => (u.endsWith('/api/v1/auth/refresh')
      ? jsonResponse({ data: { ok: true } })
      : mock.mock.calls.filter((c) => url(c as FetchCall) === u).length === 1
        ? jsonResponse({ error: { code: 'UNAUTHORIZED', message: '过期' } }, 401)
        : jsonResponse({ data: { path: u } })));
    await expect(apiFetch<{ data: { path: string } }>('/api/v1/authx/config')).resolves.toEqual({ data: { path: '/api/v1/authx/config' } });
    expect(mock.mock.calls.map((c) => url(c as FetchCall))).toEqual(['/api/v1/authx/config', '/api/v1/auth/refresh', '/api/v1/authx/config']);
  });

  it('查询串/无前导斜杠写法不影响守卫判定', async () => {
    const mock = stubFetch(() => jsonResponse({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, 401));
    await expect(apiFetch('/api/v1/auth/me?ts=1')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(apiFetch('api/v1/auth/logout')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mock).toHaveBeenCalledTimes(2); // 两次都没有 refresh
  });

  it('isAuthEndpoint：判定逻辑覆盖真实前缀/边界（大小写与相似前缀不误伤）', () => {
    expect(isAuthEndpoint('/api/v1/auth')).toBe(true);
    expect(isAuthEndpoint('/api/v1/auth/refresh')).toBe(true);
    expect(isAuthEndpoint('/api/v1/auth/me?x=1#f')).toBe(true);
    expect(isAuthEndpoint('api/v1/auth/me')).toBe(true);
    expect(isAuthEndpoint('/api/v1/authx/me')).toBe(false);
    expect(isAuthEndpoint('/api/v1/authentication')).toBe(false);
    expect(isAuthEndpoint('/api/v1/conversations')).toBe(false);
    expect(isAuthEndpoint('/api/v1/tasks/t-1')).toBe(false);
  });

  it('refresh 失败（非 2xx）→ 抛原始 401 的 ApiError，且不再重放', async () => {
    const mock = stubFetch((u) => (u.endsWith('/api/v1/auth/refresh')
      ? jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'refresh 失效' } }, 401)
      : jsonResponse({ error: { code: 'UNAUTHORIZED', message: '登录已过期', requestId: 'req-9' } }, 401)));

    await expect(apiFetch('/api/v1/conversations')).rejects.toMatchObject({
      name: 'ApiError', code: 'UNAUTHORIZED', message: '登录已过期', requestId: 'req-9',
    });
    expect(mock).toHaveBeenCalledTimes(2); // 原请求 + refresh，无第三次重放
  });

  it('重放后仍 401 → 只重试一次即抛错', async () => {
    const mock = stubFetch((u) => (u.endsWith('/api/v1/auth/refresh')
      ? jsonResponse({ data: { ok: true } })
      : jsonResponse({ error: { code: 'UNAUTHORIZED', message: '仍然过期' } }, 401)));

    await expect(apiFetch('/api/v1/conversations')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mock).toHaveBeenCalledTimes(3); // 原 + refresh + 重放一次
  });

  it('错误响应体不是 JSON → 归一化兜底 code=INTERNAL / message=请求失败', async () => {
    stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    await expect(apiFetch('/api/v1/conversations')).rejects.toMatchObject({ code: 'INTERNAL', message: '请求失败' });
  });

  it('网络层异常（fetch reject）原样向上抛出，不包装成 ApiError', async () => {
    stubFetch(() => { throw new TypeError('Failed to fetch'); });
    await expect(apiFetch('/api/v1/conversations')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('请求头与上传', () => {
  it('字符串 body 自动补 Content-Type: application/json，并始终带 CSRF 头', async () => {
    const mock = stubFetch(() => jsonResponse({ data: null }));
    await apiFetch('/api/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'p' }) });
    const headers = mock.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(mock.mock.calls[0][1]!.credentials).toBe('include');
  });

  it('FormData 上传不手动设置 Content-Type（浏览器自带 boundary），字段名与端点正确', async () => {
    const mock = stubFetch(() => jsonResponse({ data: { id: 'att-1', type: 'image', mimeType: 'image/png' } }));
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    await expect(uploadAttachment(file)).resolves.toEqual({ data: { id: 'att-1', type: 'image', mimeType: 'image/png' } });

    const [u, init] = mock.mock.calls[0] as FetchCall;
    expect(String(u)).toBe('/api/v1/attachments');
    expect(init!.method).toBe('POST');
    const headers = init!.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
    const body = init!.body as FormData;
    expect(body.get('file')).toBe(file);
  });

  it('调用方自定义头不被覆盖（合并顺序：CSRF → 内容类型 → 调用方）', async () => {
    const mock = stubFetch(() => jsonResponse({ data: null }));
    await apiFetch('/api/v1/x', { headers: { 'X-Trace-Id': 'trace-1' } });
    const headers = mock.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers['X-Trace-Id']).toBe('trace-1');
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
  });
});
