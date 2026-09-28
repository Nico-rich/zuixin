/**
 * M11-P11（审计 D1-12 / NV-13）：对象存储的**确定性时间上界**。
 *
 * 缺陷背景：`StorageS3Adapter` 改造前构造 `S3Client` 时**未配置 requestHandler** —— smithy 的
 * `DEFAULT_REQUEST_TIMEOUT = 0` 语义是"永不超时"（`@smithy/node-http-handler` 明确注释
 * "A default of 0 means no timeout"）。于是 MinIO/S3 端一旦半开（TCP 建连成功但不再回响应，
 * 或响应头迟迟不来），`put / getStream / delete` 的 Promise **永不 settle**：上传请求线程、
 * 配额预留（reservation）与连接一起挂死，且没有任何日志能说明"卡在哪一步"。
 *
 * 三段防线（自下而上，与 `core/redis/redis-resilience.ts` 的三段口径同构）：
 *   1. **建连超时** `STORAGE_S3_CONNECT_TIMEOUT_MS`（默认 5s）：TCP/TLS 握手阶段有界；
 *   2. **单请求超时** `STORAGE_S3_REQUEST_TIMEOUT_MS`（默认 30s）+ 同值的 abort 兜底：
 *      由 `NodeHttpHandler` 在 socket 层强制（超时即销毁请求），abort 兜底再补一层"请求已发出
 *      但 handler 计时未覆盖"的窗口（例如流式 Body 上传中途停滞）；
 *   3. **调用面兜底** `withStorageDeadline`（默认 `STORAGE_DEADLINE_MS` = 请求超时 + 5s 宽限）：
 *      即使底层驱动**完全不遵守**任何超时（第三方 StorageAdapter 实现、local 驱动磁盘挂死），
 *      调用方仍在确定时间内拿到结论。
 *
 * 为什么不复用 `redis-resilience.withDeadline`：那里的超时错误是 `RedisTimeoutError`
 * （码 `REDIS_TIMEOUT`，文案"Redis 操作超时"）。存储路径复用会把"对象存储超时"错报成
 * Redis 故障，运维归因失真 —— 两处边界各自持有自己的错误类型，语义不重叠。
 *
 * 归因（错误 → HTTP）：`StorageTimeoutError` 是**普通 Error**（非 AppError/HttpException），
 * 经 `GlobalExceptionFilter` 兜底分支 → **500 INTERNAL**（内部细节不外泄，服务端记 error 日志）。
 * 这满足 P11 的"有界超时 → 5xx"要求，且**无需**改公共过滤器（多 Agent 热点文件）。
 *
 * 调优提示：单请求超时是"请求发出 → 响应头到达"的全窗口，**包含大文件上传的传输时间**
 * （video 上限 200MB）。公网对象存储 + 慢链路场景请按实际带宽上调
 * `STORAGE_S3_REQUEST_TIMEOUT_MS`（或对应该链路的 `STORAGE_DEADLINE_MS`）。
 */

/** 建连（TCP/TLS 握手）超时上界（默认 5000ms） */
export const DEFAULT_S3_CONNECT_TIMEOUT_MS = 5_000;
/** 单请求（发出 → 响应头）超时上界（默认 30000ms） */
export const DEFAULT_S3_REQUEST_TIMEOUT_MS = 30_000;
/** 调用面兜底相对单请求超时的宽限（让底层驱动的超时错误优先暴露，归因更清晰） */
export const STORAGE_DEADLINE_SLACK_MS = 5_000;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** 建连超时（env STORAGE_S3_CONNECT_TIMEOUT_MS 可覆盖；非法/非正值回退默认，绝不产生 0 = 永不超时） */
export function storageConnectTimeoutMs(): number {
  return positiveInt(process.env.STORAGE_S3_CONNECT_TIMEOUT_MS, DEFAULT_S3_CONNECT_TIMEOUT_MS);
}

/** 单请求超时（env STORAGE_S3_REQUEST_TIMEOUT_MS 可覆盖；同上，0 被显式拒绝） */
export function storageRequestTimeoutMs(): number {
  return positiveInt(process.env.STORAGE_S3_REQUEST_TIMEOUT_MS, DEFAULT_S3_REQUEST_TIMEOUT_MS);
}

/**
 * 调用面兜底上界（默认 = 单请求超时 + 宽限）。
 * env `STORAGE_DEADLINE_MS` 可覆盖（测试用小值驱动"永不 settle 的驱动"路径）。
 */
export function storageDeadlineMs(): number {
  return positiveInt(process.env.STORAGE_DEADLINE_MS, storageRequestTimeoutMs() + STORAGE_DEADLINE_SLACK_MS);
}

/** 对象存储操作超时的显式错误（调用面据此区分"超时"与"业务/SDK 错误"） */
export class StorageTimeoutError extends Error {
  readonly code = 'STORAGE_TIMEOUT';
  constructor(readonly label: string, readonly timeoutMs: number) {
    super(`对象存储操作超时（${label}，>${timeoutMs}ms）`);
    this.name = 'StorageTimeoutError';
  }
}

/** 是否对象存储超时错误（含底层 abort 触发的超时；SDK 自身文案不参与判定，避免误伤业务错误） */
export function isStorageTimeoutError(err: unknown): boolean {
  return err instanceof StorageTimeoutError;
}

/**
 * 给任意 Promise 加**确定性超时上界**：成功/失败语义不变，超时抛 `StorageTimeoutError`。
 * 绝不留下未处理的 rejection（超时后原 Promise 的拒绝仍被 race 消费——与 redis 版实现同构）。
 *
 * 超时 ≠ 取消：底层调用可能仍在进行（其 socket 层的 requestTimeout/abort 兜底负责收口），
 * 但调用方在 timeoutMs 内**一定**拿到结论。
 */
export function withStorageDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StorageTimeoutError(label, timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  const settled = promise.finally(() => { if (timer) clearTimeout(timer); });
  return Promise.race([settled, guard]);
}
