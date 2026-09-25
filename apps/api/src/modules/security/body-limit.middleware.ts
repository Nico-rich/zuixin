import { NextFunction, Request, Response } from 'express';
import { ErrorCode } from '../../common/errors/app-error';

/**
 * M8-P8：body-parser（express.json/raw/urlencoded）错误的 express 级兜底。
 *
 * 为什么需要它：body parser 是 **express 级中间件**，其抛出的错误不进 Nest 的异常过滤器链
 * （Nest 只接管路由内抛出的异常），会落到 Express 默认 finalhandler → 非生产环境把
 * 堆栈/文件路径写进 HTML 响应体（信息泄露），且响应体不是平台统一 JSON 信封。
 *
 * 注册位置要求：所有 body parser 之后、路由之前（见 main.ts 与 e2e 的中间件顺序）。
 * 非 body-parser 错误一律 next(err) 交回后续处理（绝不吞异常）。
 */
export function bodyLimitErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const e = err as { type?: unknown; status?: unknown; statusCode?: unknown } | null | undefined;
  if (e && typeof e.type === 'string' && e.type.startsWith('entity.')) {
    const tooLarge = e.type === 'entity.too.large';
    const status = tooLarge ? 413 : Number(e.status ?? e.statusCode ?? 400);
    const requestId = (req as Request & { id?: string }).id;
    res.status(Number.isFinite(status) ? status : 400).json({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: tooLarge ? '请求体超过大小限制' : '请求体格式非法',
        requestId,
      },
    });
    return;
  }
  next(err);
}
