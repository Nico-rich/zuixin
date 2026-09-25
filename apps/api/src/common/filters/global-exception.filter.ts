import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { MulterError } from 'multer';
import { Request, Response } from 'express';
import { AppError, ErrorCode } from '../errors/app-error';

@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('GlobalExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const requestId = req.id;

    if (exception instanceof MulterError) {
      const msg = exception.code === 'LIMIT_FILE_SIZE' ? '文件超过上传大小限制' : `上传失败：${exception.message}`;
      res.status(HttpStatus.BAD_REQUEST).json({ error: { code: ErrorCode.VALIDATION_ERROR, message: msg, requestId } });
      return;
    }
    if (exception instanceof AppError) {
      this.logger.warn({ code: exception.code, requestId }, exception.message);
      res.status(this.httpStatusOf(exception.code)).json({ error: { code: exception.code, message: exception.message, requestId } });
      return;
    }
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const payload = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : { message: body };
      res.status(exception.getStatus()).json({ error: { code: (payload.code as string) ?? ErrorCode.INTERNAL, message: (payload.message as string) ?? '请求失败', requestId } });
      return;
    }
    this.logger.error({ requestId, stack: (exception as Error)?.stack }, '未捕获异常');
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: { code: ErrorCode.INTERNAL, message: '服务器内部错误', requestId } });
  }

  private httpStatusOf(code: string): number {
    switch (code) {
      case 'VALIDATION_ERROR': return HttpStatus.BAD_REQUEST;
      case 'UNAUTHORIZED': return HttpStatus.UNAUTHORIZED;
      case 'FORBIDDEN': return HttpStatus.FORBIDDEN;
      case 'NOT_FOUND': return HttpStatus.NOT_FOUND;
      case 'QUOTA_EXCEEDED': case 'RATE_LIMITED': return HttpStatus.TOO_MANY_REQUESTS;
      case 'TASK_NOT_CANCELLABLE': return HttpStatus.CONFLICT;
      case 'RUN_NOT_CANCELLABLE': case 'RUN_NOT_RETRYABLE': return HttpStatus.CONFLICT; // M6-P5：终态不可取消/非终态不可重试
      case 'APPROVAL_NOT_PENDING': case 'APPROVAL_EXPIRED': return HttpStatus.CONFLICT; // M7-P1：审批已决/已过期
      case 'CONNECTION_NOT_REFRESHABLE': case 'CONNECTION_REVOKED': return HttpStatus.CONFLICT; // M7-P2
      case 'CONNECTION_NOT_ACTIVE': return HttpStatus.CONFLICT; // M7-P3
      case 'WORKFLOW_NOT_PUBLISHED': return HttpStatus.CONFLICT; // M7-P6
      case 'WORKFLOW_RUN_NOT_CANCELLABLE': case 'WORKFLOW_RUN_NOT_RETRYABLE': return HttpStatus.CONFLICT; // M7-P6
      case 'WEBHOOK_REPLAY': return HttpStatus.CONFLICT; // M7-P6
      case 'WEBHOOK_SIGNATURE_INVALID': return HttpStatus.UNAUTHORIZED; // M7-P6
      case 'OAUTH_STATE_INVALID': case 'OAUTH_STATE_EXPIRED': return HttpStatus.BAD_REQUEST; // M7-P2
      case 'PROVIDER_UNSUPPORTED': return HttpStatus.NOT_FOUND; // M7-P2
      case 'PROVIDER_UNAVAILABLE': return HttpStatus.SERVICE_UNAVAILABLE; // M8-P7：无可用 provider（服务端裁决，非客户端错误）
      case 'UNSUPPORTED_PARAMETER': return HttpStatus.BAD_REQUEST;
      default: return HttpStatus.BAD_GATEWAY; // provider 类错误
    }
  }
}
