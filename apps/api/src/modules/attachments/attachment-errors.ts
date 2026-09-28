import { HttpException } from '@nestjs/common';
import { ErrorCode, type ErrorCodeType } from '../../common/errors/app-error';

/**
 * M10-P7 附件安全专用错误（带 HTTP 状态语义的 M10 错误码载体）。
 *
 * 为什么不是 AppError：`GlobalExceptionFilter.httpStatusOf` 对 M10 新增错误码**尚未映射**
 * （未命中 switch 分支 → 兜底 502 BAD_GATEWAY），而该过滤器是多 Agent 热点公共文件、
 * 不在 P7 所有权内（集成阶段由 Coordinator 统一收口）。过滤器对 HttpException 分支**显式支持**
 * payload.code（`payload.code ?? INTERNAL`），因此这里同时携带 code + status：
 * 外部契约（400/429 + 专用错误码）成立，且**不需要**触碰公共文件。
 *
 * 集成后若 `httpStatusOf` 补上 ATTACHMENT_* 两行映射，本类可退化为 `new AppError(...)`
 * （调用方只依赖 code，不依赖类身份）。
 */
export class AttachmentHttpError extends HttpException {
  constructor(readonly code: ErrorCodeType, message: string, status: number) {
    super({ code, message }, status);
    this.name = 'AttachmentHttpError';
  }
}

export function attachmentError(code: ErrorCodeType, message: string, status: number): AttachmentHttpError {
  return new AttachmentHttpError(code, message, status);
}

/** 压缩炸弹/畸形归档 → 400 ATTACHMENT_UNZIP_REJECTED */
export function unzipRejected(message: string): AttachmentHttpError {
  return attachmentError(ErrorCode.ATTACHMENT_UNZIP_REJECTED, message, 400);
}

/** 每用户附件配额超限 → 429 ATTACHMENT_QUOTA_EXCEEDED */
export function attachmentQuotaExceeded(message: string): AttachmentHttpError {
  return attachmentError(ErrorCode.ATTACHMENT_QUOTA_EXCEEDED, message, 429);
}
