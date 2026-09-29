import { describe, expect, it } from 'vitest';
import {
  decideRouteAccess, isNonPagePath, isProtectedPath, isPublicPath,
  normalizePathname, sanitizeReturnTo, shouldUseSecureCookie,
} from '@/lib/route-guard';

/**
 * 路由守卫判定（纯函数，M13-F1）
 * 与 middleware.test.ts 分工：这里穷举边界（路径规范化/公开路径/非页面路径/open-redirect），
 * 那里验证真实 NextRequest + 真实 middleware 的落地行为。
 */
describe('路径规范化', () => {
  it('去查询串/结尾斜杠，根路径与空串归一到 /', () => {
    expect(normalizePathname('/chat/')).toBe('/chat');
    expect(normalizePathname('/chat?x=1#f')).toBe('/chat');
    expect(normalizePathname('')).toBe('/');
    expect(normalizePathname('/')).toBe('/');
    expect(normalizePathname('/chat//')).toBe('/chat');
  });
});

describe('公开 / 受保护路径', () => {
  it('/login 与其子路径公开；其余页面全部受保护', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/login/')).toBe(true);
    expect(isPublicPath('/login/reset')).toBe(true);
    expect(isProtectedPath('/login')).toBe(false);

    for (const p of ['/', '/chat', '/chat/abc', '/workflows', '/evaluation/runs/r1', '/marketplace/p1/manage', '/agents', '/settings']) {
      expect(isPublicPath(p), `${p} 应受保护`).toBe(false);
      expect(isProtectedPath(p)).toBe(true);
    }
  });

  it('区分大小写不敏感是**不**做的：/Login 不是公开路径（后端路由同样大小写敏感）', () => {
    expect(isPublicPath('/Login')).toBe(false);
  });

  it('非页面路径（/api 代理、/_next、静态文件）不受页面守卫管辖', () => {
    for (const p of ['/api', '/api/v1/auth/login', '/_next/static/a.js', '/favicon.ico', '/logo.svg', '/robots.txt']) {
      expect(isNonPagePath(p), `${p} 应判为非页面路径`).toBe(true);
      expect(isPublicPath(p)).toBe(true); // 非页面路径一律放行（鉴权归后端）
      expect(isProtectedPath(p)).toBe(false);
    }
    for (const p of ['/apix', '/chat', '/settings']) {
      expect(isNonPagePath(p), `${p} 不应被判为非页面路径`).toBe(false);
    }
  });
});

describe('decideRouteAccess', () => {
  it('无会话 cookie 访问受保护页 → 重定向登录，并带上 path+query', () => {
    expect(decideRouteAccess({ pathname: '/chat', hasAccessCookie: false })).toEqual({ action: 'redirect-login', returnTo: '/chat' });
    expect(decideRouteAccess({ pathname: '/evaluation/runs/r1', search: '?tab=score', hasAccessCookie: false }))
      .toEqual({ action: 'redirect-login', returnTo: '/evaluation/runs/r1?tab=score' });
  });

  it('会话 cookie 存在 → 一律放行（存在性判定；有效性由 AppShell/可选校验兜底）', () => {
    expect(decideRouteAccess({ pathname: '/chat', hasAccessCookie: true })).toEqual({ action: 'allow' });
    expect(decideRouteAccess({ pathname: '/', hasAccessCookie: true })).toEqual({ action: 'allow' });
  });

  it('公开路径/非页面路径无 cookie 也放行（否则登录页会自我重定向成死循环）', () => {
    for (const p of ['/login', '/api/v1/auth/login', '/_next/static/a.js']) {
      expect(decideRouteAccess({ pathname: p, hasAccessCookie: false }), p).toEqual({ action: 'allow' });
    }
  });

  it('returnTo 只允许站内路径：拒绝协议相对/绝对/伪协议/含反斜杠或空白的值', () => {
    expect(sanitizeReturnTo('/chat')).toBe('/chat');
    expect(sanitizeReturnTo('/chat?projectId=p1')).toBe('/chat?projectId=p1');
    for (const evil of ['//evil.com', 'https://evil.com', 'javascript:alert(1)', '/\\evil.com', '/a\\b', '', null, undefined]) {
      expect(sanitizeReturnTo(evil as string | null | undefined), String(evil)).toBeNull();
    }
    // 指向公开页/非页面路径的 returnTo 没有意义（会造成登录后原地打转）
    expect(sanitizeReturnTo('/login')).toBeNull();
    expect(sanitizeReturnTo('/api/v1/x')).toBeNull();
  });
});

describe('cookie Secure 口径与 API 一致', () => {
  it('生产或显式 COOKIE_SECURE=true 才加 Secure', () => {
    expect(shouldUseSecureCookie({ NODE_ENV: 'production' })).toBe(true);
    expect(shouldUseSecureCookie({ COOKIE_SECURE: 'true' })).toBe(true);
    expect(shouldUseSecureCookie({ NODE_ENV: 'development' })).toBe(false);
    expect(shouldUseSecureCookie({})).toBe(false);
  });
});
