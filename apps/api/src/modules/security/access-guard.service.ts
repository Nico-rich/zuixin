import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * M8-P8 访问判定的"缓存友好"读取面（JwtAuthGuard 使用）：
 * - userStatus：access token 未过期时用户可能已被禁用 → 每个请求校验 DB 状态，
 *   以短 TTL 进程内缓存把"每请求一次 SELECT"降为"每 TTL 一次 SELECT"；
 * - sessionLiveness：access token 携带 sid 时校验对应 session 未被撤销（登出/轮换即失效）。
 *
 * 缓存语义（诚实边界）：
 * - 只缓存**肯定结论**（active / live），TTL 内不重复查库；
 * - 否定结论（disabled / 已撤销）不缓存（避免缓存"也许已恢复"的中间态语义混乱）；
 * - 同进程内的状态变更方（logout / 后续 admin 禁用接口）必须调用 invalidate* 立即生效；
 * - 跨进程（多实例部署）存在 ≤ TTL 的窗口——TTL 由 SECURITY_GUARD_CACHE_TTL_MS 控制（默认 5000ms）。
 */
const DEFAULT_TTL_MS = 5000;

@Injectable()
export class AccessGuardService {
  private readonly ttlMs = Number(process.env.SECURITY_GUARD_CACHE_TTL_MS ?? DEFAULT_TTL_MS);
  private readonly userStatusCache = new Map<string, { active: boolean; at: number }>();
  private readonly sessionCache = new Map<string, { live: boolean; at: number }>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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

  /** 用户状态变更（禁用/启用）后调用 */
  invalidateUser(userId: string): void {
    this.userStatusCache.delete(userId);
  }

  /** 会话撤销（登出/轮换/管理员踢出）后调用 */
  invalidateSession(sessionId: string): void {
    this.sessionCache.delete(sessionId);
  }

  /** 测试/诊断：当前缓存规模 */
  stats(): { users: number; sessions: number } {
    return { users: this.userStatusCache.size, sessions: this.sessionCache.size };
  }
}
