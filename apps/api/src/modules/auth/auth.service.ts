import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { AuditService, maskEmail } from '../audit/audit.service';
import { RedisKVService } from '../../core/circuit-breaker/redis-kv.service';
import { LOGIN_FAIL_WINDOW_SEC, LOGIN_MAX_FAILS, REFRESH_TTL_SEC } from './auth.constants';

export interface RequestMeta { ip: string; userAgent?: string; }

export interface AuthResult {
  accessToken: string; refreshToken: string;
  user: { id: string; email: string; displayName: string | null; role: string };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(RedisKVService) private readonly kv: RedisKVService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
    // M8-P3 login 审计（@Optional：审计面缺失时登录主流程照常；AppModule/WorkerModule 均注册 @Global AuditModule）
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
  ) {}

  async login(email: string, password: string, meta: RequestMeta): Promise<AuthResult> {
    const failKey = `auth:loginfail:${meta.ip}`;
    const fails = Number(await this.kv.get(failKey) ?? '0');
    if (fails >= LOGIN_MAX_FAILS) {
      throw new AppError(ErrorCode.RATE_LIMITED, '登录尝试过于频繁，请 5 分钟后再试');
    }
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = user != null && await argon2.verify(user.passwordHash, password);
    if (!ok) {
      await this.kv.incr(failKey, LOGIN_FAIL_WINDOW_SEC);
      // M8-P3 login 审计：失败也留痕（metadata 仅邮箱掩码+IP；绝不落密码）。
      // AuditLog.userId 是非空外键：未知邮箱无 userId 可归属 → 仅结构化 warn（不伪造归属）。
      if (user) {
        await this.audit?.write({
          userId: user.id, action: 'auth.login_failed', result: 'denied', reason: '凭证无效',
          metadata: { email: maskEmail(email), ip: meta.ip },
        });
      } else {
        this.logger.warn({ email: maskEmail(email), ip: meta.ip }, '登录失败：邮箱不存在（无归属用户，跳过审计写入）');
      }
      throw new AppError(ErrorCode.UNAUTHORIZED, '邮箱或密码错误'); // 统一文案防用户枚举
    }
    if (user.status !== 'active') {
      await this.audit?.write({
        userId: user.id, action: 'auth.login_failed', result: 'denied', reason: '账号已被禁用',
        metadata: { email: maskEmail(email), ip: meta.ip },
      });
      throw new AppError(ErrorCode.FORBIDDEN, '账号已被禁用');
    }
    await this.kv.set(failKey, '0', LOGIN_FAIL_WINDOW_SEC);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    // M8-P1：懒创建 Personal Organization（幂等；多租户基线）
    const personalOrg = await this.orgs.ensurePersonalOrganization(user.id).catch(() => null);
    // M8-P3 login 审计：审计面 best-effort（write 内部吞异常，绝不影响登录结果）
    await this.audit?.write({
      userId: user.id, action: 'auth.login', organizationId: personalOrg?.id ?? null, result: 'success',
      metadata: { email: maskEmail(user.email), ip: meta.ip },
    });
    return this.issueTokens(user, meta);
  }

  async refresh(rawRefresh: string | undefined, meta: RequestMeta): Promise<AuthResult> {
    if (!rawRefresh) throw new AppError(ErrorCode.UNAUTHORIZED, '未登录');
    const session = await this.prisma.session.findUnique({ where: { tokenHash: this.hash(rawRefresh) } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new AppError(ErrorCode.UNAUTHORIZED, '登录已过期，请重新登录');
    }
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || user.status !== 'active') throw new AppError(ErrorCode.UNAUTHORIZED, '账号不可用');
    await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } }); // 轮换
    return this.issueTokens(user, meta);
  }

  async logout(rawRefresh: string | undefined): Promise<void> {
    if (!rawRefresh) return;
    await this.prisma.session.updateMany({
      where: { tokenHash: this.hash(rawRefresh), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'active') throw new AppError(ErrorCode.UNAUTHORIZED, '账号不可用');
    return { user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role } };
  }

  private async issueTokens(user: { id: string; email: string; displayName: string | null; role: string }, meta: RequestMeta): Promise<AuthResult> {
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role });
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.session.create({
      data: {
        userId: user.id, tokenHash: this.hash(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
        userAgent: meta.userAgent, ip: meta.ip,
      },
    });
    return {
      accessToken, refreshToken,
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    };
  }

  private hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
}
