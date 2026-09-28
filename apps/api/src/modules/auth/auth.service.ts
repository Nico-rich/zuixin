import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { AuditService, maskEmail } from '../audit/audit.service';
import { RedisKVService } from '../../core/circuit-breaker/redis-kv.service';
import { AccessGuardService } from '../security/access-guard.service';
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
    // M8-P8 会话缓存（登出后立即失效；@Optional 仅为保持最小可构造性，AppModule 场景由 @Global SecurityModule 提供）
    @Optional() @Inject(AccessGuardService) private readonly access?: AccessGuardService,
  ) {}

  async login(email: string, password: string, meta: RequestMeta): Promise<AuthResult> {
    const failKey = `auth:loginfail:${meta.ip}`;
    // Pre-M9 G4 降级（**fail-open**）：登录失败计数是**保护面**（防暴力破解），不是登录正确性面。
    // Redis 不可用/超时时放行本次尝试并告警，绝不因基础设施故障把全站登录打死。
    // 已知取舍：Redis 故障窗口内该计数失效（argon2 校验成本 + 上游限流仍在）。
    const fails = await this.readLoginFails(failKey);
    if (fails >= LOGIN_MAX_FAILS) {
      throw new AppError(ErrorCode.RATE_LIMITED, '登录尝试过于频繁，请 5 分钟后再试');
    }
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = user != null && await argon2.verify(user.passwordHash, password);
    if (!ok) {
      await this.bumpLoginFails(failKey);
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
    await this.clearLoginFails(failKey);
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

  /**
   * Pre-M9 G4：登录失败计数的三条 Redis 通道全部**显式降级**（fail-open，理由见 login 注释）：
   * 读失败 → 视为 0 次（放行）；写失败 → 告警（本次失败未计数）；清零失败 → 告警（成功登录仍继续）。
   * 关键点：**成功登录绝不被计数器写失败拖垮**（否则 Redis 抖动会让所有正确密码都登不进来）。
   */
  private async readLoginFails(failKey: string): Promise<number> {
    try {
      const raw = await this.kv.get(failKey);
      const n = Number(raw ?? '0');
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (err) {
      this.logger.warn(`登录失败计数读取失败（降级：放行本次尝试，登录锁在该窗口失效）: ${(err as Error).message}`);
      return 0;
    }
  }

  private async bumpLoginFails(failKey: string): Promise<void> {
    try {
      await this.kv.incr(failKey, LOGIN_FAIL_WINDOW_SEC);
    } catch (err) {
      this.logger.warn(`登录失败计数写入失败（降级：本次失败未计数）: ${(err as Error).message}`);
    }
  }

  private async clearLoginFails(failKey: string): Promise<void> {
    try {
      await this.kv.set(failKey, '0', LOGIN_FAIL_WINDOW_SEC);
    } catch (err) {
      this.logger.warn(`登录失败计数清零失败（降级：登录继续，计数留待 TTL 自然过期）: ${(err as Error).message}`);
    }
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

  /**
   * M8-P8 登出：撤销 refresh 会话 +（防御纵深）撤销当前 access token 所属会话。
   * 只靠 refresh cookie 时，若 refresh cookie 缺失/过期则会话不会被撤销、access token 仍可用约 15 分钟；
   * 传入 access token 的 sid（已验签）后，两种 cookie 任一存在即可完成会话撤销。
   */
  async logout(rawRefresh: string | undefined, accessSessionId?: string): Promise<void> {
    const conditions: Array<{ tokenHash: string } | { id: string }> = [];
    if (rawRefresh) conditions.push({ tokenHash: this.hash(rawRefresh) });
    if (accessSessionId) conditions.push({ id: accessSessionId });
    if (!conditions.length) return;
    await this.prisma.session.updateMany({
      where: { OR: conditions, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // 进程内会话缓存立即失效（无需等待 TTL；跨进程仍有 ≤ TTL 窗口，见 AccessGuardService 注释）
    if (accessSessionId) this.access?.invalidateSession(accessSessionId);
  }

  /** 从 access token 提取会话 id（仅本地验签，不查库；验签失败/无 sid → null） */
  async sessionIdFromAccessToken(accessToken: string | undefined): Promise<string | null> {
    if (!accessToken) return null;
    try {
      const payload = await this.jwt.verifyAsync<{ sid?: string }>(accessToken);
      return payload?.sid ?? null;
    } catch {
      return null;
    }
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'active') throw new AppError(ErrorCode.UNAUTHORIZED, '账号不可用');
    return { user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role } };
  }

  private async issueTokens(user: { id: string; email: string; displayName: string | null; role: string }, meta: RequestMeta): Promise<AuthResult> {
    // M8-P8：会话 id 由服务端预生成 → access token 携带 sid（登出/撤销后 access token 立即失效）。
    // 预生成而非依赖 create 返回值：签发与落库的 id 一致且无竞态。
    const sessionId = randomUUID();
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId: user.id, tokenHash: this.hash(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
        userAgent: meta.userAgent, ip: meta.ip,
      },
    });
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role, sid: sessionId });
    return {
      accessToken, refreshToken,
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    };
  }

  private hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
}
