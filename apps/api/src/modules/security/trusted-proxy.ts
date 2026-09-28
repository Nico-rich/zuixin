/**
 * M10-P1 × M10-P8：Express `trust proxy` 与全局 per-IP 限流的**可信跳口径统一**（唯一实现，纯函数可单测）。
 *
 * ## 为什么要统一
 * auth 的登录失败计数用 Express `req.ip`（= socket 地址），而全局限流
 * （`core/rate-limit/global-rate-limit.policy.ts`）自己解析 `TRUSTED_PROXY_HOPS` + `X-Forwarded-For`。
 * 反代部署下两者口径不一致时，auth 计数会退化成"所有用户共用一个代理 IP"——正常用户被邻居的
 * 失败尝试连带锁死（A8 在策略文件里记录的跨模块风险；修复归属 auth/main.ts 所有权，即本文件）。
 * 打开 Express 的 `trust proxy = N` 后，`req.ip` 与 `resolveClientIp(hops)` 语义一致：
 * **取 XFF 链右起第 N 跳**（客户端只能往左追加，边界代理追加的那一跳抗伪造；链长不足回退 socket 地址）。
 *
 * ## 安全边界（失败方向必须是"不信任"）
 * 只有**显式配置 N > 0** 才设置：未配置 / 空串 / 非法 / 0 / 负数一律保持 Express 默认
 * （不信任任何 `X-Forwarded-For`）。直连部署若设置了它，等于把限流分桶与登录失败计数的依据
 * 交给一个客户端可任意伪造的头部——那是比"口径不一致"严重得多的降级，因此默认必须是 0。
 */

/** 可信反代层数（默认 0 = 不信任 XFF）。解析失败一律回退 0，绝不猜。 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** 最小结构约束（只依赖 getHttpAdapter().getInstance()，避免为类型引入平台包依赖） */
export interface TrustProxyTarget {
  getHttpAdapter(): { getInstance<T = unknown>(): T };
}

/**
 * 在 N > 0 时把可信跳数写进 Express（`app.set('trust proxy', N)`）。
 * @returns 实际生效的层数（0 = 未设置，保持 Express 默认）
 */
export function applyTrustedProxy(app: TrustProxyTarget, env: NodeJS.ProcessEnv = process.env): number {
  const hops = trustedProxyHops(env);
  if (hops <= 0) return 0;
  app.getHttpAdapter().getInstance<{ set(key: string, value: unknown): void }>().set('trust proxy', hops);
  return hops;
}
