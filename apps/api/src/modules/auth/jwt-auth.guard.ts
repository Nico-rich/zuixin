import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { COOKIE_ACCESS } from './auth.constants';

export interface AuthedUser { userId: string; role: string; }

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const token = (req.cookies as Record<string, string> | undefined)?.[COOKIE_ACCESS];
    if (!token) throw new AppError(ErrorCode.UNAUTHORIZED, '未登录');
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; role: string }>(token);
      req.user = { userId: payload.sub, role: payload.role };
      return true;
    } catch {
      throw new AppError(ErrorCode.UNAUTHORIZED, '登录已过期');
    }
  }
}
