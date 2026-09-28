import type { RedisOptions } from 'ioredis';

/**
 * Pre-M9 G4：Redis 韧性基线（**命令超时 + 有界重试 + 显式失败**）。
 *
 * 背景：改造前多处 Redis 客户端使用 `maxRetriesPerRequest: null`（ioredis 的"命令无限重试"语义），
 * 一旦 Redis 不可达/网络半开，命令 Promise **永不 settle** → 请求线程、SSE 订阅、队列投递、
 * 事件发布全部挂住（进程只能被强杀）。G4 的统一口径：
 *   1. **命令超时**（`commandTimeout`）：单条命令超过上界即显式失败；
 *   2. **有界重试**（`maxRetriesPerRequest`）：有限次重试后抛错，绝不无限重试；
 *   3. **调用面兜底**（`withDeadline`）：即使命令滞留在 ioredis 离线队列（不产生 commandTimeout），
 *      调用面仍有确定性上界；
 *   4. **各路径显式降级**：catch 后要么 fail-open（放行，附理由），要么 fail-closed（显式错误码），
 *      绝不"静默挂起"或"静默吞掉"——降级理由见各调用点注释。
 *
 * 例外：BullMQ 的 Worker 连接**必须**保留 `maxRetriesPerRequest: null`（BullMQ 用阻塞命令取作业，
 * ioredis 对有界重试会直接报错），因此队列投递的边界由 `core/queue/bounded-add.ts` 在调用面兜底。
 */

/** 单条命令超时上界（默认 1000ms） */
export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 1_000;
/** 建连超时上界（默认 2000ms） */
export const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 2_000;
/** 命令级重试上限（默认 2：首次 + 2 次重试后显式抛错） */
export const DEFAULT_REDIS_MAX_RETRIES_PER_REQUEST = 2;
/** 重连退避上界（默认 2000ms；重连本身可长期进行，但单次退避有界） */
export const DEFAULT_REDIS_RETRY_BACKOFF_MS = 2_000;
/** 调用面兜底相对命令超时的宽限（让客户端自身的超时错误优先暴露，语义更清晰） */
export const REDIS_CALL_DEADLINE_SLACK_MS = 500;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** 命令超时（env REDIS_COMMAND_TIMEOUT_MS 可覆盖，测试可调小） */
export function redisCommandTimeoutMs(): number {
  return positiveInt(process.env.REDIS_COMMAND_TIMEOUT_MS, DEFAULT_REDIS_COMMAND_TIMEOUT_MS);
}

/** 建连超时（env REDIS_CONNECT_TIMEOUT_MS 可覆盖） */
export function redisConnectTimeoutMs(): number {
  return positiveInt(process.env.REDIS_CONNECT_TIMEOUT_MS, DEFAULT_REDIS_CONNECT_TIMEOUT_MS);
}

/** 命令级重试上限（env REDIS_MAX_RETRIES 可覆盖；0 = 不重试） */
export function redisMaxRetries(): number {
  const raw = process.env.REDIS_MAX_RETRIES;
  if (raw === undefined) return DEFAULT_REDIS_MAX_RETRIES_PER_REQUEST;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : DEFAULT_REDIS_MAX_RETRIES_PER_REQUEST;
}

/** 调用面兜底上界（命令超时 + 宽限） */
export function redisCallDeadlineMs(): number {
  return redisCommandTimeoutMs() + REDIS_CALL_DEADLINE_SLACK_MS;
}

/** Redis 操作超时的显式错误（调用面据此区分"超时降级"与"业务错误"） */
export class RedisTimeoutError extends Error {
  readonly code = 'REDIS_TIMEOUT';
  constructor(readonly label: string, readonly timeoutMs: number) {
    super(`Redis 操作超时（${label}，>${timeoutMs}ms）`);
    this.name = 'RedisTimeoutError';
  }
}

/** 是否 Redis 超时错误（含 ioredis 自身的 commandTimeout 报错文案） */
export function isRedisTimeoutError(err: unknown): boolean {
  if (err instanceof RedisTimeoutError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /timed out|timeout/i.test(msg) && /command|redis|connect/i.test(msg);
}

/**
 * 给任意 Promise 加**确定性超时上界**：成功/失败语义不变，超时抛 RedisTimeoutError。
 * 绝不留下未处理的 rejection（超时后原 Promise 的拒绝仍被消费）。
 */
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RedisTimeoutError(label, timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  const settled = promise.finally(() => { if (timer) clearTimeout(timer); });
  return Promise.race([settled, guard]);
}

/**
 * 非阻塞 Redis 客户端的统一选项（KV / 限流 / 事件发布等）：
 * 命令超时 + 有界重试 + 有界退避 + 建连超时。
 * **不要**用于 BullMQ Worker 连接（需 `maxRetriesPerRequest: null`）。
 */
export function boundedRedisOptions(extra?: RedisOptions): RedisOptions {
  return {
    connectTimeout: redisConnectTimeoutMs(),
    commandTimeout: redisCommandTimeoutMs(),
    maxRetriesPerRequest: redisMaxRetries(),
    enableOfflineQueue: true, // 冷启动/重连窗口内的命令仍入队（但受 commandTimeout + 调用面兜底约束）
    retryStrategy: (times: number) => Math.min(Math.max(times, 1) * 200, DEFAULT_REDIS_RETRY_BACKOFF_MS),
    ...extra,
  };
}
