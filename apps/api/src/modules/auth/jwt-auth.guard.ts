import { CanActivate, ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { COOKIE_ACCESS } from './auth.constants';
import { AccessGuardService } from '../security/access-guard.service';

export interface AuthedUser { userId: string; role: string; sessionId?: string; }

/**
 * JWT 载荷：sid = 签发该 access token 的会话 id（M8-P8 起签发）；jti = token 唯一 id（M10-P1 起签发）。
 * 历史/内部签发的 token 两个声明都可能缺失——缺失时跳过对应校验（向后兼容），不退化为"无校验放行"。
 */
interface AccessPayload { sub: string; role: string; sid?: string; jti?: string; iat?: number; exp?: number; }

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    // M8-P8：禁用用户阻断 + 会话撤销判定（@Optional 仅为保持既有单测/最小模块可构造性；
    // AppModule 场景下 SecurityModule 必然提供 —— 见 security.module.ts）
    @Optional() @Inject(AccessGuardService) private readonly access?: AccessGuardService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const token = (req.cookies as Record<string, string> | undefined)?.[COOKIE_ACCESS];
    if (!token) throw new AppError(ErrorCode.UNAUTHORIZED, '未登录');
    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token);
    } catch {
      throw new AppError(ErrorCode.UNAUTHORIZED, '登录已过期');
    }
    if (!payload?.sub) throw new AppError(ErrorCode.UNAUTHORIZED, '登录已过期');

    if (this.access) {
      // 0) M10-P1 SA-4/X-20：jti 黑名单（登出全部/主动轮换）——token 粒度最先判定
      if (payload.jti && (await this.access.isJtiBlocked(payload.jti))) {
        throw new AppError(ErrorCode.UNAUTHORIZED, '登录已失效，请重新登录');
      }
      // 1) 会话撤销：token 携带 sid 时校验会话仍然有效（登出/轮换/设备下线后 access token 立即失效）
      if (payload.sid && !(await this.access.isSessionLive(payload.sid))) {
        // M11-P2（D1-01，**DEVICE_REVOKED 的唯一业务抛出点**）：拒绝结论恒来自 DB 会话状态（上一行），
        // 此处只把"原因"细化为 DEVICE_REVOKED —— 客户端据此提示"该设备已被下线"并**停止重试**，
        // 而不是笼统的"登录已过期"（后者会让客户端反复刷新换不回会话）。
        // 原因标记缺失/Redis 故障 → 退化回 UNAUTHORIZED：**只影响文案，绝不影响放行/拒绝**。
        const deviceRevoked = await this.access.isSessionDeviceRevoked(payload.sid);
        throw deviceRevoked
          ? new AppError(ErrorCode.DEVICE_REVOKED, '该设备已被下线，请重新登录')
          : new AppError(ErrorCode.UNAUTHORIZED, '登录已失效，请重新登录');
      }
      // 2) 禁用用户阻断：access token 未过期 ≠ 用户仍可用（禁用后不得再访问任何受保护端点）
      if (!(await this.access.isUserActive(payload.sub))) {
        throw new AppError(ErrorCode.UNAUTHORIZED, '账号不可用');
      }
    }

    req.user = { userId: payload.sub, role: payload.role, ...(payload.sid ? { sessionId: payload.sid } : {}) };
    return true;
  }
}
