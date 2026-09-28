import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionEventsService } from './session-events.service';
import type { SessionEvent } from './session-events.service';

/**
 * M8-P8 访问判定的"缓存友好"读取面（JwtAuthGuard 使用）：
 * - userStatus：access token 未过期时用户可能已被禁用 → 每个请求校验 DB 状态，
 *   以短 TTL 进程内缓存把"每请求一次 SELECT"降为"每 TTL 一次 SELECT"；
 * - sessionLiveness：access token 携带 sid 时校验对应 session 未被撤销（登出/轮换即失效）；
 * - jtiBlacklist（M10-P1 SA-4/X-20）：主动轮换/登出全部写入的 jti 墓碑，token 粒度第二道闸。
 *
 * 缓存语义（诚实边界）：
 * - 只缓存**肯定结论**（active / live / 未拉黑），TTL 内不重复查库/查 Redis；
 * - 否定结论（disabled / 已撤销 / 已拉黑）不缓存（避免缓存"也许已恢复"的中间态语义混乱）；
 * - 同进程内的状态变更方（logout / logout-all）必须调用 invalidate* 立即生效；
 * - **跨进程（多实例部署）：M10-P1 起不再是"≤ TTL 窗口"** —— `SessionEventsService` 订阅 Redis pub/sub
 *   `session-events`，撤销/禁用事件到达即清本实例肯定缓存，撤销**立即**全实例生效；
 *   仅当 Redis pub/sub 不可用时退化为 ≤ TTL 窗口（TTL 由 SECURITY_GUARD_CACHE_TTL_MS 控制，默认 5000ms）。
 */
const DEFAULT_TTL_MS = 5000;

@Injectable()
export class AccessGuardService implements OnModuleInit {
  private readonly ttlMs = Number(process.env.SECURITY_GUARD_CACHE_TTL_MS ?? DEFAULT_TTL_MS);
  private readonly userStatusCache = new Map<string, { active: boolean; at: number }>();
  private readonly sessionCache = new Map<string, { live: boolean; at: number }>();
  /** jti 未拉黑（肯定结论）缓存；key = jti */
  private readonly jtiOkCache = new Map<string, number>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    // @Optional：单测/最小上下文可直接构造；AppModule 场景由 @Global SecurityModule 提供
    @Optional() @Inject(SessionEventsService) private readonly events?: SessionEventsService,
  ) {}

  onModuleInit(): void {
    // M10-P1 SA-1/X-10：跨实例撤销传播——收到事件即清本实例肯定缓存（下一个请求重新查库）
    this.events?.registerListener((event) => this.applyRemoteEvent(event));
  }

  /** 用户是否可访问（status === 'active'） */
  async isUserActive(userId: string): Promise<boolean> {
    const cached = this.userStatusCache.get(userId);
    const now = Date.now();
    if (cached && now - cached.at < this.ttlMs) return cached.active;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    const active = user?.status === 'active';
    if (active) this.userStatusCache.set(userId, { active: true, at: now });
    else this.userStatusCache.delete(userId);
    return active;
  }

  /** session 是否仍然有效（存在 + 未撤销 + 未过期） */
  async isSessionLive(sessionId: string): Promise<boolean> {
    const cached = this.sessionCache.get(sessionId);
    const now = Date.now();
    if (cached && now - cached.at < this.ttlMs) return cached.live;
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId }, select: { revokedAt: true, expiresAt: true },
    });
    const live = session != null && session.revokedAt == null && session.expiresAt > new Date();
    if (live) this.sessionCache.set(sessionId, { live: true, at: now });
    else this.sessionCache.delete(sessionId);
    return live;
  }

  /**
   * M10-P1 SA-4：该 jti 是否已被主动拉黑（登出全部 / 管理员踢出 / 主动轮换）。
   * Redis 故障 → fail-open（未拉黑）：权威的撤销判定在 DB 会话状态（isSessionLive），
   * 黑名单是纵深层而非唯一依据——Redis 抖动绝不能把全站鉴权打死。
   */
  async isJtiBlocked(jti: string): Promise<boolean> {
    const now = Date.now();
    const cachedAt = this.jtiOkCache.get(jti);
    if (cachedAt !== undefined && now - cachedAt < this.ttlMs) return false;
    const blocked = (await this.events?.isJtiBlacklisted(jti)) ?? false;
    if (blocked) this.jtiOkCache.delete(jti);
    else this.jtiOkCache.set(jti, now);
    return blocked;
  }

  /** 用户状态变更（禁用/启用）后调用 */
  invalidateUser(userId: string): void {
    this.userStatusCache.delete(userId);
  }

  /** 会话撤销（登出/轮换/管理员踢出）后调用 */
  invalidateSession(sessionId: string): void {
    this.sessionCache.delete(sessionId);
    this.jtiOkCache.clear(); // jti ↔ session 映射不在本层维护：保守清空（代价只是重新查一次 Redis）
  }

  /**
   * 跨实例事件到达后的本地失效（M10-P1 SA-1/X-10）。
   * 粒度取"能精确的精确、不能精确的清空"：会话级事件删该会话；用户级事件删该用户并把会话面整体清空
   * （用户级撤销会同时影响该用户的多个会话，而本层不维护 userId→sessionIds 反查索引）。
   */
  private applyRemoteEvent(event: SessionEvent): void {
    this.jtiOkCache.clear();
    if (event.sessionId) this.sessionCache.delete(event.sessionId);
    if (event.userId) this.userStatusCache.delete(event.userId);
    if (event.type !== 'session.revoked') this.sessionCache.clear();
  }

  /** 测试/诊断：当前缓存规模 */
  stats(): { users: number; sessions: number; jti: number } {
    return { users: this.userStatusCache.size, sessions: this.sessionCache.size, jti: this.jtiOkCache.size };
  }
}
