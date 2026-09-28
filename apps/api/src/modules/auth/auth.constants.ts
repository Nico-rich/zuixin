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

/**
 * M11-P2（D1-01/D1-10）设备标识（deviceId）契约：
 * - **来源**：登录时客户端上报；header `X-Device-Id` 优先，请求体 `deviceId` 字段兜底
 *   （两者都缺 → 不写 deviceId：会话照常可用，只是不参与"按设备下线"分组）。
 *   选 header 优先的理由：deviceId 是"这台客户端"的稳定属性而非一次登录的参数；header 不进请求体校验/审计体，
 *   且既有客户端（web `apiFetch`）统一加头改动面最小。
 * - **信任模型**：服务端**不信任其内容**——它只是"同一设备"的**分组标识**，绝不参与鉴权裁决
 *   （按设备下线的查询恒带 `userId = 令牌主体`，伪造 deviceId 只能影响伪造者自己的会话分组）。
 * - **清洗**：去控制字符（含 CR/LF，防日志注入）+ 首尾空白 + 长度截断；清洗后为空 → 视为未提供。
 *   超长恒截断而**不拒绝登录**：非法标识不该被放大成拒绝服务面。
 */
export const DEVICE_ID_HEADER = 'x-device-id';
export const DEVICE_ID_MAX_LEN = 128;

/** 可打印字符判定：C0 控制字符（含 CR/LF/TAB）与 DEL 绝不写库、绝不进日志 */
function isPrintableChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

export function normalizeDeviceId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined; // 重复头（数组）/非字符串一律视为未提供
  const cleaned = [...raw].filter(isPrintableChar).join('').trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, DEVICE_ID_MAX_LEN);
}
