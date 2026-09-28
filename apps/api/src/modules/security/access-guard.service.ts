import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
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
 * - **容量有界（M11-P2 D1-11 收口）**：三个缓存都有条目上限（默认 5000，env SECURITY_GUARD_CACHE_MAX_ENTRIES）。
 *   M10 审计结论是"只受 TTL 约束、无条数上限"——而 TTL 只影响**命中**，不影响**驻留**：
 *   条目过期后仍留在 Map 里（只有再次访问该 key 或收到事件才会被删/覆盖），
 *   于是一个长期在线、用户基数大的实例上，缓存会随**历史用户/会话/jti 总量**单调增长。
 */
const DEFAULT_TTL_MS = 5000;
/** 每个进程内缓存的条目上限（env SECURITY_GUARD_CACHE_MAX_ENTRIES 可覆盖） */
const DEFAULT_MAX_ENTRIES = 5000;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

@Injectable()
export class AccessGuardService implements OnModuleInit {
  private readonly logger = new Logger('AccessGuard');
  private readonly ttlMs = Number(process.env.SECURITY_GUARD_CACHE_TTL_MS ?? DEFAULT_TTL_MS);
  /** 三个缓存的容量上限（构造期读取；测试可注入 env 覆盖） */
  readonly maxEntries = positiveInt(process.env.SECURITY_GUARD_CACHE_MAX_ENTRIES, DEFAULT_MAX_ENTRIES);
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
    if (active) this.setBounded(this.userStatusCache, userId, { active: true, at: now });
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
    if (live) this.setBounded(this.sessionCache, sessionId, { live: true, at: now });
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
    else this.setBounded(this.jtiOkCache, jti, now);
    return blocked;
  }

  /**
   * M11-P2（D1-01）：该会话是否由"设备下线"撤销——**仅供 JwtAuthGuard 细化 401 的错误码**
   * （通用"登录已失效" vs "该设备已被下线"）。调用点在 `isSessionLive === false` 之后，
   * 即"已经要拒绝"的路径上，因此这里只回答"原因"，绝不参与放行/拒绝裁决。
   * Redis 故障/无标记/安全面缺失 → false（退化回 UNAUTHORIZED）。
   */
  async isSessionDeviceRevoked(sessionId: string): Promise<boolean> {
    return (await this.events?.isSessionDeviceRevoked(sessionId)) ?? false;
  }

  /**
   * M11-P2（D1-11）有界写入：达到条目上限时**整表清空**再写入。
   * 取舍（简单有界 > 精确淘汰）：
   * - 三个缓存只存**肯定结论**，丢失的代价 = 一次重新查库/查 Redis（幂等且廉价）；
   * - O(1) 且**绝无 OOM 面**：不做 LRU（Map 的插入序 ≠ 访问序，"最旧"不等于"最冷"，
   *   维护成本换不来可解释性），也不逐条淘汰（清表已给出硬上界）；
   * - 触发即清空会让**整个实例**短暂回到冷态（一次突发 DB 读），因此上限取 5000（远大于稳态工作集）。
   */
  private setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
    if (map.size >= this.maxEntries && !map.has(key)) {
      this.logger.warn(`访问判定缓存达到上限（${this.maxEntries} 条）→ 整表清空重建（冷态一次，不影响正确性）`);
      map.clear();
    }
    map.set(key, value);
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
