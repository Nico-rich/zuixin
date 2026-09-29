import { AppError, ErrorCode } from '@ai-agent/shared';

/** 不继承 Error：Error 的 name 为必填，厂商错误对象的 name 可能缺失 */
export interface ProviderLikeError { status?: number; code?: string; name?: string; message?: string; }

/** 厂商错误 → 归一化 AppError（retryable 标记驱动回退/熔断决策）——common 层，供 core/providers 共用 */
export function mapProviderError(err: ProviderLikeError): AppError {
  if (err.name === 'AbortError' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
    return new AppError(ErrorCode.PROVIDER_TIMEOUT, '模型请求超时');
  }
  // 厂商原始报错**必须透传**（M13+ 实测：归一化文案丢弃厂商详情后无法定位 400 根因——
  // 用户看到的「请求参数错误」掩盖了 DeepSeek 拒绝的真实参数）。截断防超长。
  const detail = err.message ? `（厂商：${err.message.slice(0, 300)}）` : '';
  switch (err.status) {
    case 429: return new AppError(ErrorCode.PROVIDER_RATE_LIMITED, `模型服务限流${detail}`);
    case 401: case 403: return new AppError(ErrorCode.PROVIDER_AUTH, `模型服务鉴权失败${detail}`);
    case 400: case 404: case 422: return new AppError(ErrorCode.PROVIDER_BAD_REQUEST, `模型请求参数错误${detail}`);
    case 500: case 502: case 503: case 504: return new AppError(ErrorCode.PROVIDER_OVERLOADED, `模型服务过载${detail}`);
    default: return new AppError(ErrorCode.PROVIDER_UNKNOWN, err.message || '模型服务未知错误');
  }
}
