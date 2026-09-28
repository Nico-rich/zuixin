import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, ErrorCode } from '../errors/app-error';
import { AuthedUser } from '../../modules/auth/jwt-auth.guard';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  /**
   * M10-P15（BUG-7）：**显式 @Inject**（与仓库既有约定一致：vitest/esbuild 转译不产出
   * `design:paramtypes`，隐式按类型注入在测试/转译运行时下会拿到 `undefined`）。
   * 此前隐式注入让 `this.reflector` 为 undefined → `canActivate` 抛 TypeError → 平台管理员
   * 门禁恒 500 而非 403（`GET/POST /agents/*` 的越权判定在 e2e 中完全不可验证）。
   * 不是提权（异常发生在角色判定之前，失败关闭），但门禁语义错误且不可测。
   */
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;
    const req = ctx.switchToHttp().getRequest<{ user?: AuthedUser }>();
    if (!req.user || !required.includes(req.user.role)) {
      throw new AppError(ErrorCode.FORBIDDEN, '需要管理员权限');
    }
    return true;
  }
}
