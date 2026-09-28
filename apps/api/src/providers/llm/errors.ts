import { AppError, ErrorCode } from '../../common/errors/app-error';
import { mapProviderError, ProviderLikeError } from '../../common/errors/provider-error';

export { mapProviderError } from '../../common/errors/provider-error';
export type { ProviderLikeError } from '../../common/errors/provider-error';

/**
 * M10-P2（contract e2e 真实 HTTP 发现）：OpenAI SDK 的**中止/超时**类错误识别。
 *
 * SDK 在"自身 timeout"与"调用方 signal abort"两种情况下抛 `APIConnectionTimeoutError` /
 * `APIUserAbortError`——二者**既无 `status` 也无 `code`**（构造函数名是唯一可靠特征），
 * 落到 `mapProviderError` 会被归为 `PROVIDER_UNKNOWN`（**不可重试**）。这与本平台的四层超时契约
 * （`StreamGuard` / G6：超时 = `PROVIDER_TIMEOUT`，可重试/可回退）相冲突：真实厂商"慢/卡"会把
 * 回合变成不可重试的 unknown（引擎既不重试也不换 provider，直接判 run 失败）。
 *
 * 诚实边界：本判定只看错误形状（SDK 类名/平台中止名），**不推断厂商语义**——调用方（引擎）
 * 仍以 `ctx.signal.aborted` 优先识别"用户取消"，取消语义不被本函数改变。
 */
export function isSdkAbortOrTimeout(err: unknown): boolean {
  const e = err as { constructor?: { name?: string }; name?: string; code?: string } | null;
  const ctor = e?.constructor?.name ?? '';
  if (ctor === 'APIConnectionTimeoutError' || ctor === 'APIUserAbortError') return true;
  return e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.code === 'ETIMEDOUT';
}

/**
 * SDK 错误归一（chat/stream 共用出口）：
 * 1. 已是 AppError（本平台语义，含 StreamGuard 层超时）→ 原样透传，绝不降级；
 * 2. SDK 中止/超时（无 status/code）→ `PROVIDER_TIMEOUT`（可重试/可回退，四层超时契约）；
 * 3. 其余按 `mapProviderError` 归一（429→RATE_LIMITED / 401→AUTH / 400→BAD_REQUEST / 5xx→OVERLOADED）。
 */
export function mapSdkError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (isSdkAbortOrTimeout(err)) return new AppError(ErrorCode.PROVIDER_TIMEOUT, '模型请求超时');
  return mapProviderError(err as ProviderLikeError);
}

export function toChatError(err: unknown, requestId?: string): AppError {
  if (err instanceof AppError) return err;
  const wrapped = mapSdkError(err);
  return new AppError(wrapped.code, wrapped.message, requestId);
}
