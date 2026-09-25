import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { RateLimitService } from './rate-limit.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

export interface RateLimitOptions {
  /** 键空间名（同一用户/主体共享窗口） */
  name: string;
  limit: number;
  windowMs: number;
  /** 自定义键（缺省 = name:userId 或 name:ip） */
  keyFn?: (req: Request) => string;
}

export const RATE_LIMIT_KEY = 'm7:rate-limit';
export const RateLimit = (opts: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, opts);

/**
 * M7-P9 速率限制守卫：@RateLimit({...}) + @UseGuards(RateLimitGuard)。
 * 超限 → 429 RATE_LIMITED（AppError）；Redis 不可用 → 放行（限流是保护面，不放大故障）。
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const config = this.reflector.get<RateLimitOptions | undefined>(RATE_LIMIT_KEY, ctx.getHandler());
    if (!config) return true;
    const req = ctx.switchToHttp().getRequest<Request & { user?: { userId: string } }>();
    const key = config.keyFn ? config.keyFn(req) : `${config.name}:${req.user?.userId ?? req.ip ?? 'anon'}`;
    const ok = await this.limiter.consume(key, config.limit, config.windowMs);
    if (!ok) throw new AppError(ErrorCode.RATE_LIMITED, '请求过于频繁，请稍后再试');
    return true;
  }
}
