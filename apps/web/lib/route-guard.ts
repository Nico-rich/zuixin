/**
 * 服务端路由守卫判定（M13-F1）
 *
 * 本文件刻意**不 import 任何 Next 运行时**（next/server、next/navigation）：
 * 判定逻辑是纯函数，可被 vitest 直接覆盖（jsdom 下无需 Edge 运行时垫片）；
 * `apps/web/middleware.ts` 只是它的薄适配层。
 *
 * 与 API 的事实对齐（见 apps/api/src/modules/auth/auth.constants.ts）：
 *  - 会话 cookie 名 = `agent_access`（HttpOnly / Path=/ / SameSite=Lax / Max-Age 900s，JWT）
 *  - `agent_refresh` 的 Path=/api/v1/auth → **页面导航请求不会携带它**，故页面侧守卫只能看 `agent_access`
 *  - 过期后浏览器会直接丢弃 `agent_access`（Max-Age 到期）→ 无需解析 JWT 过期时间
 *  - API 只认 cookie（不认 Authorization: Bearer），所以「cookie 是否存在」是页面侧唯一可用信号
 *  - 刷新会话（POST /api/v1/auth/refresh）只能在浏览器里做（refresh cookie 只在 auth 路径可见），
 *    故守卫在重定向时写一个 returnTo 提示 cookie，由登录页做一次静默续期（见 app/login/page.tsx）
 */
export const ACCESS_COOKIE = 'agent_access';
export const RETURN_TO_COOKIE = 'agent_return_to';
export const LOGIN_PATH = '/login';
/** returnTo 提示 cookie 的存活时间：仅够完成一次跳转，过期即作废 */
export const RETURN_TO_MAX_AGE_SEC = 600;

/** 无需登录即可访问的页面路径（前缀匹配） */
const PUBLIC_PREFIXES: readonly string[] = [LOGIN_PATH];

/**
 * 不参与页面鉴权判定的路径（由 middleware matcher 先行排除，这里再兜一层，
 * 保证判定函数在被直接调用时语义仍然正确）：
 *  - `/api/*`：Next rewrites 代理到后端，鉴权与 CSRF 由后端负责；未登录也必须可达（否则无法登录）
 *  - `/_next/*`、带扩展名的静态资源：构建产物与静态文件
 */
const NON_PAGE_PREFIXES: readonly string[] = ['/api', '/_next'];
const STATIC_FILE = /\.[a-z0-9]+$/i;

export function normalizePathname(pathname: string): string {
  const clean = (pathname.split(/[?#]/)[0] || '/').trim();
  if (clean === '') return '/';
  const trimmed = clean.replace(/\/+$/, ''); // 连续结尾斜杠一并去掉（/chat// → /chat）
  return trimmed === '' ? '/' : trimmed;
}

/** 是否是「不需要登录」的路径 */
export function isPublicPath(pathname: string): boolean {
  const path = normalizePathname(pathname);
  if (isNonPagePath(path)) return true;
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** 静态资源 / API 代理等非页面路径（不受页面守卫管辖） */
export function isNonPagePath(pathname: string): boolean {
  const path = normalizePathname(pathname);
  if (NON_PAGE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return true;
  return STATIC_FILE.test(path);
}

/** 是否需要登录（= 非公开的页面路由） */
export function isProtectedPath(pathname: string): boolean {
  return !isPublicPath(pathname);
}

/**
 * 校验「登录后回到哪里」的值：只接受站内绝对路径。
 * 拒绝 `//evil.com`、`https://evil.com`、`javascript:` 等协议相对/绝对/伪协议写法（开放重定向防护）。
 */
export function sanitizeReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  if (value.includes('\\')) return null;
  if (/[\s]/.test(value)) return null;
  const path = normalizePathname(value);
  if (isNonPagePath(path) || isPublicPath(path)) return null;
  return value;
}

export interface RouteAccessInput {
  pathname: string;
  /** 原始查询串（含 `?`，可省略） */
  search?: string;
  /** 请求是否携带 agent_access cookie（只看存在性） */
  hasAccessCookie: boolean;
}

export type RouteAccessDecision =
  | { action: 'allow' }
  | { action: 'redirect-login'; returnTo: string | null };

/**
 * 页面路由访问判定：
 *  - 公开路径（/login）与静态/API 路径 → allow
 *  - 受保护路径且无会话 cookie → redirect-login（带上原始 path+search 作为 returnTo）
 *  - 其余 → allow
 *
 * 注意：本判定**不**校验 token 有效性（页面侧做不到：refresh cookie 不可见）。
 * 携带无效 cookie 的情况由两步兜底：①可选的 middleware 服务端 /auth/me 校验（WEB_AUTH_VERIFY_SESSION=1）；
 * ②AppShell 的客户端兜底（/auth/me 失败 → 跳登录页）。
 */
export function decideRouteAccess({ pathname, search = '', hasAccessCookie }: RouteAccessInput): RouteAccessDecision {
  if (!isProtectedPath(pathname)) return { action: 'allow' };
  if (hasAccessCookie) return { action: 'allow' };
  const target = `${normalizePathname(pathname)}${search.startsWith('?') ? search : search ? `?${search}` : ''}`;
  return { action: 'redirect-login', returnTo: sanitizeReturnTo(target) };
}

/** 是否启用服务端会话校验（默认关闭：每次导航多一次 API 往返，仅在需要即时吊销语义时打开） */
export function isSessionVerificationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.WEB_AUTH_VERIFY_SESSION === '1' || env.WEB_AUTH_VERIFY_SESSION === 'true';
}

/** 是否给 cookie 加 Secure（与 API 的 secureSuffix 口径一致） */
export function shouldUseSecureCookie(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === 'production' || env.COOKIE_SECURE === 'true';
}
