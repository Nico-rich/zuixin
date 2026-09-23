import { AppError, ErrorCode } from '../../common/errors/app-error';

interface ProviderLikeError extends Error { status?: number; code?: string; name?: string; }

/** 厂商错误 → 归一化 AppError（retryable 标记驱动回退/熔断决策） */
export function mapProviderError(err: ProviderLikeError): AppError {
  if (err.name === 'AbortError' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
    return new AppError(ErrorCode.PROVIDER_TIMEOUT, '模型请求超时');
  }
  switch (err.status) {
    case 429: return new AppError(ErrorCode.PROVIDER_RATE_LIMITED, '模型服务限流');
    case 401: case 403: return new AppError(ErrorCode.PROVIDER_AUTH, '模型服务鉴权失败');
    case 400: case 404: case 422: return new AppError(ErrorCode.PROVIDER_BAD_REQUEST, '模型请求参数错误');
    case 500: case 502: case 503: case 504: return new AppError(ErrorCode.PROVIDER_OVERLOADED, '模型服务过载');
    default: return new AppError(ErrorCode.PROVIDER_UNKNOWN, err.message || '模型服务未知错误');
  }
}

export function toChatError(err: unknown, requestId?: string): AppError {
  if (err instanceof AppError) return err;
  const wrapped = mapProviderError(err as ProviderLikeError);
  return new AppError(wrapped.code, wrapped.message, requestId);
}
