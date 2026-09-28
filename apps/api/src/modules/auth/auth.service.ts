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
import { SessionEventsService } from '../security/session-events.service';
import {
  ACCESS_TTL_SEC, LOGIN_FAIL_WINDOW_SEC, LOGIN_MAX_FAILS, REFRESH_TTL_SEC,
  normalizeDeviceId, sessionConcurrencyPolicy, sessionMaxConcurrent,
} from './auth.constants';

/** M11-P2：`deviceId` 为可选的设备分组标识（来源见 auth.constants；服务端不信任其内容） */
export interface RequestMeta { ip: string; userAgent?: string; deviceId?: string; }

export interface AuthResult {
  accessToken: string; refreshToken: string;
  user: { id: string; email: string; displayName: string | null; role: string };
}

/** 会话管理端点回传的会话摘要（**绝不含 tokenHash/refresh token**） */
export interface SessionSummary {
  id: string; deviceId: string | null; userAgent: string | null; ip: string | null;
  createdAt: Date; expiresAt: Date;
  /** 是否为发起本次请求的会话（前端据此标注"当前设备"并禁止误下线自己） */
  current: boolean;
}

/** access token 里与本服务治理相关的声明（M10-P1：sid 定位会话、jti 支持主动轮换黑名单） */
export interface AccessClaims { sessionId?: string; jti?: string; exp?: number; }

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
    // M10-P1 SA-1/SA-4：跨实例撤销传播（pub/sub `session-events`）+ jti 黑名单记账
    @Optional() @Inject(SessionEventsService) private readonly events?: SessionEventsService,
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
    // M10-P1 X-21 / D16（**仅登录入口**）：组织禁用态 → 拒绝签发会话。
    // 判定对象：用户**个人组织**——登录时尚无"当前组织"上下文，个人组织是登录建立的默认租户上下文。
    // 非个人组织的禁用由资源守卫裁决（A14 OrgStatusGuard，M10-P14）；本处不越权覆盖资源面。
    const personalOrgRow = await this.prisma.organization.findFirst({
      where: { ownerUserId: user.id, isPersonal: true, deletedAt: null },
      select: { status: true },
    });
    if (personalOrgRow?.status === 'disabled') {
      await this.audit?.write({
        userId: user.id, action: 'auth.login_failed', result: 'denied', reason: '所属组织已被禁用',
        metadata: { email: maskEmail(email), ip: meta.ip },
      });
      throw new AppError(ErrorCode.ORG_DISABLED, '所属组织已被禁用，无法登录');
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
    // M11-P2：deviceId **继承**既有会话而非重新采集——续期不改变"这是哪台设备"，
    // 否则设备分组会在刷新后被清空，按设备下线将漏掉刷新过的会话。
    return this.issueTokens(user, { ...meta, deviceId: session.deviceId ?? undefined });
  }

  /**
   * M11-P2（D1-10）token 轮换：旧 refresh + 旧 access → 新 refresh + 新 access。
   *
   * 语义（**由测试锁定**）：
   * - 旧会话行被**撤销**（`revokedAt`），新会话行**新建**——与 `refresh` 同构，而非"同 Session 改 tokenHash"。
   *   取舍理由：sid 随新会话更换 → 旧 access token 在 DB 面即失效（`isSessionLive(sid)=false`），
   *   不依赖 Redis jti 墓碑（墓碑写入是纵深、可降级）；"同 Session 改 hash"则让旧 access token 只剩
   *   黑名单这一层防线，Redis 抖动时旧 token 会活到自然过期。
   * - 旧 access token 的 jti **同时**进黑名单（纵深第二层）+ 发布 `session.revoked`（跨实例立即失效）。
   * - deviceId/userAgent/ip 由旧会话继承（轮换不改变设备分组，见 refresh 注释）。
   *
   * 绑定性：access token 的 sid 必须与 refresh token 指向**同一会话**，否则拒绝——
   * 否则"持有他人 refresh token 但没有对应 access token"或"access/refresh 混用"都能换来新凭证。
   * 并发：旧会话撤销走 CAS（`revokedAt: null`），两个并发 rotate 只有一个成功，另一个 401（旧 refresh 不可重放）。
   */
  async rotate(rawRefresh: string | undefined, claims: AccessClaims | null | undefined, meta: RequestMeta): Promise<AuthResult> {
    if (!rawRefresh) throw new AppError(ErrorCode.UNAUTHORIZED, '未登录');
    if (!claims?.sessionId) throw new AppError(ErrorCode.UNAUTHORIZED, '登录已失效，请重新登录');
    const session = await this.prisma.session.findUnique({ where: { tokenHash: this.hash(rawRefresh) } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new AppError(ErrorCode.UNAUTHORIZED, '登录已过期，请重新登录');
    }
    if (session.id !== claims.sessionId) {
      throw new AppError(ErrorCode.UNAUTHORIZED, '登录凭证不匹配，请重新登录');
    }
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || user.status !== 'active') throw new AppError(ErrorCode.UNAUTHORIZED, '账号不可用');
    const revoked = await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) throw new AppError(ErrorCode.UNAUTHORIZED, '登录已失效，请重新登录'); // 并发轮换的败者
    this.access?.invalidateSession(session.id); // 本进程立即失效
    await this.blacklistAccessToken(claims);    // 旧 jti 进黑名单（纵深）
    await this.events?.publish({ type: 'session.revoked', sessionId: session.id, userId: session.userId });
    return this.issueTokens(user, { ...meta, deviceId: session.deviceId ?? undefined });
  }

  /**
   * M11-P2（D1-10）本人会话列表（会话管理端点）。
   * 只回**活跃**会话（未撤销且未过期）：撤销过的会话对用户没有管理价值，且会把"历史设备"变成信息噪音。
   * 脱敏口径：白名单字段（id/deviceId/userAgent/ip/createdAt/expiresAt/current）——
   * tokenHash 与任何 token **绝不出现在响应里**（含错误路径）。
   */
  async listSessions(userId: string, currentSessionId?: string): Promise<SessionSummary[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, deviceId: true, userAgent: true, ip: true, createdAt: true, expiresAt: true },
    });
    return rows.map((r) => ({ ...r, current: currentSessionId === r.id }));
  }

  /**
   * M11-P2（D1-10）本人单会话下线。
   * **IDOR 口径**：查询与撤销恒带 `userId`（令牌主体），他人会话与幽灵 id **同码同文案**（404 防枚举）；
   * 已撤销/已过期会话 → 幂等返回 `{ revokedSessions: 0 }`（不报错，也不假装撤销成功）。
   */
  async revokeSession(userId: string, sessionId: string): Promise<{ revokedSessions: number }> {
    const owned = await this.prisma.session.findFirst({ where: { id: sessionId, userId }, select: { id: true } });
    if (!owned) throw new AppError(ErrorCode.NOT_FOUND, '会话不存在');
    const res = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date() },
    });
    if (res.count === 0) return { revokedSessions: 0 }; // 已撤销/已过期：幂等
    this.access?.invalidateSession(sessionId);
    await this.events?.publish({ type: 'session.revoked', sessionId, userId });
    return { revokedSessions: res.count };
  }

  /**
   * M11-P2（D1-01）按设备下线：撤销**本人在该设备上**的全部活跃会话。
   *
   * - 作用域恒为"令牌主体 + 该 deviceId"，因此伪造 deviceId 只能影响伪造者自己的会话分组，无跨租户面。
   * - 该设备无活跃会话 → 幂等 `{ revokedSessions: 0 }`（不抛错：把"重复下线"变成客户端错误会带来
   *   误判性登出，且幂等语义更容易重试；见 jwt-auth.guard 中 DEVICE_REVOKED 的真实抛出点）。
   * - 每个被撤销会话各发一条 `session.revoked`（**沿用既有事件载荷，不新增字段**）：远端实例按
   *   sessionId 精确清肯定缓存（若只发 userId，`session.revoked` 不清会话面缓存 → 远端仍放行 ≤ TTL）。
   * - 另写"设备下线原因标记"（Redis，TTL = access token 上限寿命）：仅用于把这些会话随后的 401
   *   **细化为 DEVICE_REVOKED**；撤销的权威判定仍是 DB 的 `revokedAt`（标记丢失只降级错误码，绝不放行）。
   */
  async revokeDeviceSessions(userId: string, rawDeviceId: string): Promise<{ revokedSessions: number; sessionIds: string[] }> {
    const deviceId = normalizeDeviceId(rawDeviceId);
    if (!deviceId) throw new AppError(ErrorCode.VALIDATION_ERROR, '设备标识不合法');
    const targets = await this.prisma.session.findMany({
      where: { userId, deviceId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (targets.length === 0) return { revokedSessions: 0, sessionIds: [] };
    await this.prisma.session.updateMany({
      where: { userId, deviceId, revokedAt: null }, data: { revokedAt: new Date() },
    });
    const sessionIds = targets.map((t) => t.id);
    await this.events?.markDeviceRevoked(sessionIds, ACCESS_TTL_SEC);
    for (const id of sessionIds) {
      this.access?.invalidateSession(id);
      await this.events?.publish({ type: 'session.revoked', sessionId: id, userId });
    }
    return { revokedSessions: sessionIds.length, sessionIds };
  }

  /**
   * M8-P8 登出：撤销 refresh 会话 +（防御纵深）撤销当前 access token 所属会话。
   * 只靠 refresh cookie 时，若 refresh cookie 缺失/过期则会话不会被撤销、access token 仍可用约 15 分钟；
   * 传入 access token 的 sid（已验签）后，两种 cookie 任一存在即可完成会话撤销。
   */
  async logout(rawRefresh: string | undefined, accessSessionId?: string, claims?: AccessClaims | null): Promise<void> {
    const conditions: Array<{ tokenHash: string } | { id: string }> = [];
    if (rawRefresh) conditions.push({ tokenHash: this.hash(rawRefresh) });
    if (accessSessionId) conditions.push({ id: accessSessionId });
    if (!conditions.length) return;
    // 先取将被撤销的会话（用于跨实例事件携带 userId/sessionId；updateMany 不回传受影响行）
    const targets = await this.prisma.session.findMany({
      where: { OR: conditions, revokedAt: null }, select: { id: true, userId: true },
    });
    await this.prisma.session.updateMany({
      where: { OR: conditions, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    for (const t of targets) this.access?.invalidateSession(t.id); // 本进程立即失效
    if (accessSessionId) this.access?.invalidateSession(accessSessionId);
    // M10-P1 SA-4/X-20：当前 access token 的 jti 一并拉黑（TTL = 剩余寿命）——
    // 纵深：即使会话行被其他路径"复活"，这个已登出的 token 也不再可用。
    await this.blacklistAccessToken(claims);
    // M10-P1 SA-1/X-10：跨实例撤销传播（其他实例立即清肯定缓存，不再等 TTL）
    await this.events?.publish({
      type: 'session.revoked',
      ...(accessSessionId ? { sessionId: accessSessionId } : targets[0] ? { sessionId: targets[0].id } : {}),
      ...(targets[0] ? { userId: targets[0].userId } : {}),
    });
  }

  /**
   * M10-P1 SA-4/X-20：登出全部（撤销该用户**全部**活跃会话 + 拉黑其全部有效 jti + 跨实例传播）。
   * 用途：用户主动"登出所有设备"、管理员踢出、检测到凭证泄漏后的应急撤销。
   * 返回实际撤销的会话数与拉黑的 jti 数（可审计的事实，不做乐观上报）。
   */
  async logoutAll(userId: string, claims?: AccessClaims | null): Promise<{ revokedSessions: number; blacklistedJtis: number }> {
    const targets = await this.prisma.session.findMany({
      where: { userId, revokedAt: null }, select: { id: true },
    });
    const revoked = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null }, data: { revokedAt: new Date() },
    });
    for (const t of targets) this.access?.invalidateSession(t.id);
    // 当前这次请求所用的 token 也拉黑（其 jti 可能因记账通道降级而不在集合里）
    await this.blacklistAccessToken(claims);
    const blacklistedJtis = (await this.events?.blacklistAllUserJtis(userId)) ?? 0;
    await this.events?.publish({ type: 'user.sessions_revoked', userId });
    return { revokedSessions: revoked.count, blacklistedJtis };
  }

  /** 从 access token 提取治理相关声明（仅本地验签，不查库；验签失败 → null） */
  async accessTokenClaims(accessToken: string | undefined): Promise<AccessClaims | null> {
    if (!accessToken) return null;
    try {
      const payload = await this.jwt.verifyAsync<{ sid?: string; jti?: string; exp?: number }>(accessToken);
      return {
        ...(payload?.sid ? { sessionId: payload.sid } : {}),
        ...(payload?.jti ? { jti: payload.jti } : {}),
        ...(typeof payload?.exp === 'number' ? { exp: payload.exp } : {}),
      };
    } catch {
      return null;
    }
  }

  /** 从 access token 提取会话 id（仅本地验签，不查库；验签失败/无 sid → null） */
  async sessionIdFromAccessToken(accessToken: string | undefined): Promise<string | null> {
    return (await this.accessTokenClaims(accessToken))?.sessionId ?? null;
  }

  /** 把 access token 的 jti 写入黑名单；TTL = token 剩余寿命（绝不留比 token 更久的墓碑） */
  private async blacklistAccessToken(claims?: AccessClaims | null): Promise<void> {
    if (!claims?.jti || !this.events) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const exp = claims.exp ?? nowSec + ACCESS_TTL_SEC;
    await this.events.blacklistJti(claims.jti, exp - nowSec);
  }

  /**
   * M10-P1 SA-1：每用户活跃会话上限（并发会话治理）。
   * 策略见 auth.constants.sessionConcurrencyPolicy（默认 evict-oldest = 挤掉最旧，保证用户始终可登录）。
   * 竞态口径：挤占用 `updateMany({ id, revokedAt: null })` 做 CAS；CAS 未命中（并发登录已挤掉）时
   * **保守拒绝**（SESSION_CONCURRENCY_EXCEEDED），绝不放任会话数突破上限。
   */
  private async enforceSessionLimit(userId: string): Promise<void> {
    const limit = sessionMaxConcurrent();
    if (limit <= 0) return; // ≤0 = 不限制（显式关闭）
    const active = await this.prisma.session.count({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (active < limit) return;
    if (sessionConcurrencyPolicy() === 'reject') {
      throw new AppError(ErrorCode.SESSION_CONCURRENCY_EXCEEDED, `活跃会话数已达上限（${limit}），请先登出其他设备`);
    }
    const oldest = await this.prisma.session.findFirst({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!oldest) return;
    const evicted = await this.prisma.session.updateMany({
      where: { id: oldest.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (evicted.count === 0) {
      throw new AppError(ErrorCode.SESSION_CONCURRENCY_EXCEEDED, `活跃会话数已达上限（${limit}），请稍后重试`);
    }
    await this.events?.publish({ type: 'session.revoked', sessionId: oldest.id, userId });
    this.access?.invalidateSession(oldest.id);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'active') throw new AppError(ErrorCode.UNAUTHORIZED, '账号不可用');
    return { user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role } };
  }

  private async issueTokens(user: { id: string; email: string; displayName: string | null; role: string }, meta: RequestMeta): Promise<AuthResult> {
    // M10-P1 SA-1：签发前做会话并发上限准入（两条签发路径——登录与 refresh——共用本方法）
    await this.enforceSessionLimit(user.id);
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
        // M11-P2：设备分组标识（清洗后写入；来源缺失 → null，会话照常可用）
        deviceId: normalizeDeviceId(meta.deviceId) ?? null,
      },
    });
    // M10-P1 SA-4：jti 由本服务生成（而非依赖库随机）——签发即可记账，供"登出全部/主动轮换"精确拉黑
    const jti = randomUUID();
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role, sid: sessionId, jti });
    await this.events?.trackJti(user.id, jti, Math.floor(Date.now() / 1000) + ACCESS_TTL_SEC);
    return {
      accessToken, refreshToken,
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    };
  }

  private hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
}
