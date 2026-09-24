export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR', NOT_FOUND: 'NOT_FOUND', FORBIDDEN: 'FORBIDDEN',
  UNAUTHORIZED: 'UNAUTHORIZED', QUOTA_EXCEEDED: 'QUOTA_EXCEEDED', RATE_LIMITED: 'RATE_LIMITED',
  TASK_NOT_CANCELLABLE: 'TASK_NOT_CANCELLABLE',
  CONCURRENT_CHAT: 'CONCURRENT_CHAT',
  MEDIA_TASK_TIMEOUT: 'MEDIA_TASK_TIMEOUT',
  UNSUPPORTED_PARAMETER: 'UNSUPPORTED_PARAMETER',
  AGENT_MAX_STEPS: 'AGENT_MAX_STEPS',
  AGENT_RUN_TIMEOUT: 'AGENT_RUN_TIMEOUT',
  AGENT_LOOP_DETECTED: 'AGENT_LOOP_DETECTED',
  AGENT_CANCELLED: 'AGENT_CANCELLED', // M6: 用户取消导致的中断（usage 失败回合归因，不可重试）
  RUN_NOT_CANCELLABLE: 'RUN_NOT_CANCELLABLE', // M6-P5: 已终态的 run 不可取消（409）
  RUN_NOT_RETRYABLE: 'RUN_NOT_RETRYABLE',     // M6-P5: 非终态 run 不可 retry（409）
  TOOL_DENIED: 'TOOL_DENIED',
  NO_TOOL_CAPABILITY: 'NO_TOOL_CAPABILITY',
  CONTEXT_BUDGET_EXCEEDED: 'CONTEXT_BUDGET_EXCEEDED',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT', PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  PROVIDER_AUTH: 'PROVIDER_AUTH', PROVIDER_OVERLOADED: 'PROVIDER_OVERLOADED',
  PROVIDER_BAD_REQUEST: 'PROVIDER_BAD_REQUEST', PROVIDER_CONTENT_FILTERED: 'PROVIDER_CONTENT_FILTERED',
  PROVIDER_UNKNOWN: 'PROVIDER_UNKNOWN',
  ROUTER_FALLBACK: 'ROUTER_FALLBACK', INTERNAL: 'INTERNAL',
} as const;
export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 可重试（进入回退/熔断计数）的 provider 错误 */
export const RETRYABLE_CODES = new Set<ErrorCodeType>([
  ErrorCode.PROVIDER_TIMEOUT, ErrorCode.PROVIDER_RATE_LIMITED, ErrorCode.PROVIDER_OVERLOADED,
]);

export class AppError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCodeType,
    message: string,
    readonly requestId?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.retryable = RETRYABLE_CODES.has(code);
  }
  toJSON() {
    return { code: this.code, message: this.message, requestId: this.requestId };
  }
}
