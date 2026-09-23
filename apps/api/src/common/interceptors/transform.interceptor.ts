import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Response } from 'express';
import { Observable, map } from 'rxjs';

/** 统一成功信封：普通响应包成 {data}；SSE 等已直接写响应的（headersSent）跳过 */
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((data) => {
        const res = _ctx.switchToHttp().getResponse<Response>();
        if (res.headersSent) return data;
        return { data };
      }),
    );
  }
}
