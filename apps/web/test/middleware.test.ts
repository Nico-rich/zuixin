import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { config, middleware } from '@/middleware';
import { ACCESS_COOKIE, RETURN_TO_COOKIE } from '@/lib/route-guard';
import { jsonResponse } from './helpers';

/**
 * middleware 行为（M13-F1）——用**真实 NextRequest** 驱动真实 middleware 入口。
 *
 * 覆盖：未登录重定向 /login（URL 保持裸 /login）、已登录放行、公开路径与 /api 代理永不拦截、
 * 原始目标写入 returnTo cookie、可选的 /auth/me 服务端校验（开/关两态）。
 * 纯判定逻辑的穷举边界在 route-guard.test.ts（同一事实源，两层各测各的）。
 */
function req(path: string, cookies: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  return new NextRequest(new URL(`http://localhost:3000${path}`), {
    headers: cookieHeader ? { cookie: cookieHeader, ...headers } : headers,
  });
}

describe('middleware matcher', () => {
  it('排除 /api 代理与 /_next 构建产物（登录/刷新/静态资源必须匿名可达）', () => {
    const [pattern] = config.matcher;
    const re = new RegExp(`^${pattern}$`);
    // 负向：不进 middleware
    for (const path of ['/api/v1/auth/login', '/api/v1/conversations', '/_next/static/chunk.js', '/favicon.ico', '/logo.svg']) {
      expect(re.test(path), `${path} 不应进入 middleware`).toBe(false);
    }
    // 正向：页面路由进 middleware（含 W2~W9 尚未落地的路由 → 新增页面自动受保护）
    for (const path of ['/', '/login', '/chat', '/chat/abc', '/workflows', '/agents', '/knowledge', '/settings']) {
      expect(re.test(path), `${path} 应进入 middleware`).toBe(true);
    }
  });
});

describe('middleware 页面鉴权', () => {
  it('未登录访问受保护页 → 302 /login，且 URL 保持裸 /login（不挂 ?next=）', async () => {
    const res = await middleware(req('/chat?projectId=p1'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.search).toBe('');
  });

  it('未登录重定向时把原始目标（path+query）写入 returnTo 提示 cookie', async () => {
    const res = await middleware(req('/workflows/w1/runs?tab=timeline'));
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain(`${RETURN_TO_COOKIE}=`);
    // 值经 URI 编码后写入（Next 的 cookie 序列化行为）：path + query 都要完整保留，否则回跳会丢参数
    expect(decodeURIComponent(setCookie)).toContain('agent_return_to=/workflows/w1/runs?tab=timeline;');
    // 提示 cookie 不是凭据：非 HttpOnly（登录页要读并清除）、SameSite=Lax、Path=/
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('SameSite=lax');
    expect(setCookie).not.toContain('HttpOnly');
  });

  it('携带 agent_access → 放行（不重定向）', async () => {
    const res = await middleware(req('/chat', { [ACCESS_COOKIE]: 'jwt.jwt.jwt' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('无会话 cookie 访问 /login → 放行（公开路径，否则会造成重定向死循环）', async () => {
    const res = await middleware(req('/login'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('携带 cookie 访问公开路径 → 放行且不做服务端校验（登录页自行判定是否已登录）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubEnv('WEB_AUTH_VERIFY_SESSION', '1');
    const res = await middleware(req('/login', { [ACCESS_COOKIE]: 'jwt' }));
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('middleware 可选的服务端会话校验（WEB_AUTH_VERIFY_SESSION）', () => {
  it('默认关闭：不额外请求 /auth/me（页面导航零往返）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await middleware(req('/chat', { [ACCESS_COOKIE]: 'jwt' }));
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('开启且 API 判 401 → 重定向 /login 并清除 agent_access（避免导航死循环）', async () => {
    vi.stubEnv('WEB_AUTH_VERIFY_SESSION', '1');
    const fetchSpy = vi.fn(async () => jsonResponse({ error: { code: 'UNAUTHORIZED', message: '登录已过期' } }, 401));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await middleware(req('/chat', { [ACCESS_COOKIE]: 'stale-jwt' }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
    expect(res.headers.get('set-cookie')).toContain(`${ACCESS_COOKIE}=;`);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/v1/auth/me');
    // 把浏览器 cookie 原样带给 API（服务端 cookie 校验，不是 Bearer）
    expect((init.headers as Record<string, string>).cookie).toBe(`${ACCESS_COOKIE}=stale-jwt`);
  });

  it('开启且 API 判 200 → 放行', async () => {
    vi.stubEnv('WEB_AUTH_VERIFY_SESSION', '1');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: { user: { id: 'u1' } } })));
    const res = await middleware(req('/chat', { [ACCESS_COOKIE]: 'good-jwt' }));
    expect(res.status).toBe(200);
  });

  it('开启但 API 不可达（5xx/网络异常）→ 不可判定即放行，绝不在守卫层误杀', async () => {
    vi.stubEnv('WEB_AUTH_VERIFY_SESSION', '1');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const res = await middleware(req('/chat', { [ACCESS_COOKIE]: 'jwt' }));
    expect(res.status).toBe(200);
  });
});
