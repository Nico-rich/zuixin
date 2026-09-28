import { AppError, ErrorCode } from '@ai-agent/shared';

/**
 * Pre-M9 G5：外部 Provider HTTP 调用的统一超时/中止口径。
 *
 * 缺陷背景：媒体执行器把 `signal: AbortSignal.timeout(ctx.deadline - Date.now())` 放进 params，
 * 但 DashScope 适配器**从不把 signal 传给 fetch**（"死代码"），且 `provider.timeoutMs` 在
 * buildAdapter 时被丢弃 → 一次卡死的连接会拖到任务被清扫为止（无连接/请求/轮询超时，无中止）。
 *
 * 口径：
 * - **单请求超时**（连接 + 响应头 + 读体）：`AbortSignal.timeout(requestTimeoutMs)`；
 * - **整体截止**（媒体任务/AgentRun deadline）：调用方传入的 `external` 信号；
 * - 两者用 `AbortSignal.any` 组合后交给 fetch —— 任一触发都真正中止底层请求；
 * - 错误语义：外部截止 → `MEDIA_TASK_TIMEOUT`（非重试，回退无意义）；单请求超时 → AbortError
 *   （`mapProviderError` 归一为 `PROVIDER_TIMEOUT`，可重试/可回退）。
 */
export const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 60_000;

/** 判定"中止类"错误（fetch abort 的 DOMException 名字可能是 AbortError 或 TimeoutError） */
export function isAbortLike(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError' || name === 'DOMException';
}

/**
 * 组合中止信号：external（整体 deadline，可为空）+ 单请求超时。
 * 返回 `undefined` 仅当既无外部信号且 requestTimeoutMs <= 0（调用方显式要求"不设超时"）。
 */
export function composeAbortSignal(external: AbortSignal | undefined, requestTimeoutMs: number): AbortSignal | undefined {
  const timeout = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
    ? AbortSignal.timeout(Math.trunc(requestTimeoutMs)) : undefined;
  if (external && timeout) return AbortSignal.any([external, timeout]);
  return external ?? timeout;
}

/**
 * fetch 失败归一化：中止类错误**显式区分**来源——
 * 外部截止（整体 deadline 已到）→ `MEDIA_TASK_TIMEOUT`；单请求超时 → AbortError（→ PROVIDER_TIMEOUT）。
 * 非中止类错误**原样返回**（保留 status 等字段，交由 mapProviderError 判定）。
 */
export function normalizeRequestFailure(
  err: unknown,
  opts: { what: string; requestTimeoutMs: number; external?: AbortSignal },
): Error {
  if (!isAbortLike(err)) return err as Error;
  if (opts.external?.aborted) {
    return new AppError(ErrorCode.MEDIA_TASK_TIMEOUT, `${opts.what}：任务已到绝对截止时间，已中止请求`);
  }
  return Object.assign(
    new Error(`${opts.what}：请求超时（>${opts.requestTimeoutMs}ms 无响应，含连接/响应/读体）`),
    { name: 'AbortError', code: 'ETIMEDOUT' },
  );
}
