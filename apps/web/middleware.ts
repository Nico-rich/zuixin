import { NextResponse, type NextRequest } from 'next/server';
import {
  ACCESS_COOKIE, LOGIN_PATH, RETURN_TO_COOKIE, RETURN_TO_MAX_AGE_SEC,
  decideRouteAccess, isProtectedPath, isSessionVerificationEnabled, shouldUseSecureCookie,
} from '@/lib/route-guard';

/**
 * 服务端鉴权门（M13-F1）
 *
 * 替换原先的纯客户端门（app/(chat)/layout.tsx 的 useQuery → router.replace）：
 * 未登录访问受保护页时**在发送任何 HTML 之前**就 302 到 /login，消除「先渲染骨架再跳转」的闪加载，
 * 也避免受保护页面的服务端渲染内容被未登录用户看到。
 *
 * 判定口径（与 API 的事实严格对齐，详见 lib/route-guard.ts 头注释）：
 *  - 只看 `agent_access` cookie 的**存在性**：API 只认 cookie（无 Bearer），过期 cookie 会被浏览器丢弃；
 *  - `agent_refresh`（Path=/api/v1/auth）在页面导航请求里根本不会出现 → 不能作为兜底信号；
 *  - 可选的服务端 /auth/me 校验由 `WEB_AUTH_VERIFY_SESSION=1` 打开（默认关闭：避免每次导航多一次往返）。
 *
 * 与既有 CSRF/cookie 语义的兼容性：
 *  - matcher 显式排除 `/api/*`：登录/刷新/登出仍由浏览器直连（同源 rewrite），CSRF 头语义不受影响；
 *  - 本 middleware 只做 `NextResponse.redirect`（GET 导航），不代理任何写请求，不触碰 X-Requested-With；
 *  - 不写任何会话 cookie（只写一个非 HttpOnly 的 returnTo 提示 cookie，见下）。
 */
export async function middleware(request: NextRequest) {
  const { pathname, search, origin } = request.nextUrl;
  const accessToken = request.cookies.get(ACCESS_COOKIE)?.value;
  const decision = decideRouteAccess({ pathname, search, hasAccessCookie: Boolean(accessToken) });

  if (decision.action === 'allow') {
    // 可选：服务端校验会话有效性（默认关闭）。失败 → 清 cookie 并回登录页（避免死循环）。
    // 只对**受保护页面**校验：公开路径（/login）自身会处理「已登录→跳转」，在此校验纯属多余往返，
    // 且带着过期 cookie 访问 /login 时会白白多一次 /login → /login 的自我重定向。
    if (accessToken && isProtectedPath(pathname) && isSessionVerificationEnabled()) {
      const valid = await verifySession(request, accessToken);
      if (!valid) {
        const url = new URL(LOGIN_PATH, origin);
        const res = NextResponse.redirect(url);
        res.cookies.delete(ACCESS_COOKIE);
        return res;
      }
    }
    return NextResponse.next();
  }

  // 未登录 → /login。URL 保持**裸 /login**（不挂 ?next=，避免污染地址栏与既有 e2e 的 URL 断言），
  // 原始目标写入短时提示 cookie，由登录页读取后立即删除（静默续期/回跳用，见 app/login/page.tsx）。
  const response = NextResponse.redirect(new URL(LOGIN_PATH, origin));
  if (decision.returnTo) {
    response.cookies.set(RETURN_TO_COOKIE, decision.returnTo, {
      httpOnly: false, // 需要被登录页（客户端）读取并清除
      sameSite: 'lax',
      path: '/',
      maxAge: RETURN_TO_MAX_AGE_SEC,
      secure: shouldUseSecureCookie(),
    });
  }
  return response;
}

/** 服务端会话校验：直接问 API（Node/Edge 运行时 fetch）；任何异常一律视为「不可判定」→ 放行 */
async function verifySession(request: NextRequest, accessToken: string): Promise<boolean> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? `http://${request.nextUrl.hostname}:3001`;
  try {
    const res = await fetch(`${apiBase}/api/v1/auth/me`, {
      method: 'GET',
      headers: { cookie: `${ACCESS_COOKIE}=${accessToken}`, 'X-Requested-With': 'XMLHttpRequest' },
      cache: 'no-store',
    });
    // 401/403 = 会话确实无效；其它（5xx/网络异常）不可判定 → 不在守卫层误杀
    return res.status !== 401 && res.status !== 403;
  } catch {
    return true;
  }
}

/**
 * matcher：排除 `/api/*`（同源代理，登录/刷新必须匿名可达）、Next 构建产物与带扩展名的静态文件。
 * 其余**全部页面路由**（含未来 W2~W9 新增的页面）自动纳入保护，新增页面无需改本文件。
 */
export const config = {
  matcher: ['/((?!api/|api$|_next/|.*\\..*).*)'],
};
