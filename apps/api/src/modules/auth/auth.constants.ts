export const COOKIE_ACCESS = 'agent_access';
export const COOKIE_REFRESH = 'agent_refresh';
export const ACCESS_TTL_SEC = Number(process.env.JWT_ACCESS_TTL_SEC ?? 900);
export const REFRESH_TTL_SEC = Number(process.env.JWT_REFRESH_TTL_SEC ?? 30 * 24 * 3600);
export const LOGIN_MAX_FAILS = 5;
export const LOGIN_FAIL_WINDOW_SEC = 300;

/**
 * M10-P1 SA-1：每用户**活跃会话数上限**（默认 5；≤0 视为不限制）。
 * 读 env 用函数而非模块常量：单测需要按用例切换（模块常量在 import 时求值会锁死）。
 */
export function sessionMaxConcurrent(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SESSION_MAX_CONCURRENT;
  if (raw === undefined || raw === '') return 5;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 5;
}

/**
 * M10-P1 SA-1：超限策略（**已选定**：默认 `evict-oldest`）。
 * 取舍：拒绝新登录会让"达到上限且无法登出（设备丢失/客户端不响应）"的用户被**永久锁在门外**，
 * 需要管理员介入；挤掉最旧会话则保证用户始终可登录，代价是最旧设备被静默下线（已审计 + 跨实例传播）。
 * `reject` 保留给"合规要求不可静默下线设备"的部署显式选择（此时返回 SESSION_CONCURRENCY_EXCEEDED）。
 */
export type SessionConcurrencyPolicy = 'evict-oldest' | 'reject';

export function sessionConcurrencyPolicy(env: NodeJS.ProcessEnv = process.env): SessionConcurrencyPolicy {
  return env.SESSION_CONCURRENCY_POLICY === 'reject' ? 'reject' : 'evict-oldest';
}
