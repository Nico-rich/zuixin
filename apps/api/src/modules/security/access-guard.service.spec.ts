import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccessGuardService } from './access-guard.service';

function makePrisma() {
  return {
    user: { findUnique: vi.fn() },
    session: { findUnique: vi.fn() },
  };
}

/** M10-P1：SessionEventsService 的最小替身（registerListener 捕获回调 → 测试可模拟"远端事件到达"） */
function makeEvents() {
  let listener: ((e: { type: string; sessionId?: string; userId?: string }) => void) | undefined;
  return {
    isJtiBlacklisted: vi.fn().mockResolvedValue(false),
    registerListener: vi.fn((fn: typeof listener) => { listener = fn; }),
    emit: (e: { type: string; sessionId?: string; userId?: string }) => listener?.(e),
    get hasListener(): boolean { return listener !== undefined; },
  };
}

describe('AccessGuardService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: AccessGuardService;

  beforeEach(() => {
    process.env.SECURITY_GUARD_CACHE_TTL_MS = '5000';
    prisma = makePrisma();
    svc = new AccessGuardService(prisma as never);
  });

  it('active 用户 → true；disabled → false；不存在 → false', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ status: 'active' });
    expect(await svc.isUserActive('u1')).toBe(true);
    prisma.user.findUnique.mockResolvedValueOnce({ status: 'disabled' });
    expect(await svc.isUserActive('u2')).toBe(false);
    prisma.user.findUnique.mockResolvedValueOnce(null);
    expect(await svc.isUserActive('u3')).toBe(false);
  });

  it('TTL 内命中缓存（只查一次库）', async () => {
    prisma.user.findUnique.mockResolvedValue({ status: 'active' });
    expect(await svc.isUserActive('u1')).toBe(true);
    expect(await svc.isUserActive('u1')).toBe(true);
    expect(await svc.isUserActive('u1')).toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('否定结论不缓存（禁用用户每次都真实查库 → 恢复后立即生效）', async () => {
    prisma.user.findUnique.mockResolvedValue({ status: 'disabled' });
    await svc.isUserActive('u1');
    await svc.isUserActive('u1');
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it('invalidateUser 立即清缓存（缓存为 active 后禁用 → 下一次即拒绝）', async () => {
    prisma.user.findUnique.mockResolvedValue({ status: 'active' });
    expect(await svc.isUserActive('u1')).toBe(true);
    prisma.user.findUnique.mockResolvedValue({ status: 'disabled' });
    svc.invalidateUser('u1');
    expect(await svc.isUserActive('u1')).toBe(false);
  });

  it('TTL 过期后重新查库（容忍跨进程状态变更）', async () => {
    vi.useFakeTimers();
    try {
      prisma.user.findUnique.mockResolvedValue({ status: 'active' });
      await svc.isUserActive('u1');
      vi.advanceTimersByTime(6000);
      await svc.isUserActive('u1');
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('session 有效判定：未撤销未过期 → true；撤销/过期/不存在 → false', async () => {
    prisma.session.findUnique.mockResolvedValueOnce({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
    expect(await svc.isSessionLive('s1')).toBe(true);
    prisma.session.findUnique.mockResolvedValueOnce({ revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    expect(await svc.isSessionLive('s2')).toBe(false);
    prisma.session.findUnique.mockResolvedValueOnce({ revokedAt: null, expiresAt: new Date(Date.now() - 1) });
    expect(await svc.isSessionLive('s3')).toBe(false);
    prisma.session.findUnique.mockResolvedValueOnce(null);
    expect(await svc.isSessionLive('s4')).toBe(false);
  });

  it('invalidateSession 立即清缓存（登出后 access token 立即失效）', async () => {
    prisma.session.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
    expect(await svc.isSessionLive('s1')).toBe(true);
    prisma.session.findUnique.mockResolvedValue({ revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    svc.invalidateSession('s1');
    expect(await svc.isSessionLive('s1')).toBe(false);
  });

  it('stats 反映缓存规模（诊断面，M10-P1 起含 jti 面）', async () => {
    prisma.user.findUnique.mockResolvedValue({ status: 'active' });
    prisma.session.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
    await svc.isUserActive('u1');
    await svc.isSessionLive('s1');
    expect(svc.stats()).toEqual({ users: 1, sessions: 1, jti: 0 });
  });

  describe('M10-P1 SA-4：jti 黑名单判定', () => {
    let events: ReturnType<typeof makeEvents>;
    beforeEach(() => {
      events = makeEvents();
      svc = new AccessGuardService(prisma as never, events as never);
    });

    it('已拉黑 → true；未拉黑 → false（查 Redis 一次）', async () => {
      events.isJtiBlacklisted.mockResolvedValue(true);
      expect(await svc.isJtiBlocked('j1')).toBe(true);
      expect(await svc.isJtiBlocked('j1')).toBe(true);
      // 否定/肯定结论都要给出确定答案；肯定结论不缓存（黑名单只会新增，重复查询是保守侧）
      expect(events.isJtiBlacklisted).toHaveBeenCalledTimes(2);
    });

    it('未拉黑的**肯定结论**在 TTL 内命中缓存（每请求一次 Redis → 每 TTL 一次）', async () => {
      expect(await svc.isJtiBlocked('j1')).toBe(false);
      expect(await svc.isJtiBlocked('j1')).toBe(false);
      expect(await svc.isJtiBlocked('j1')).toBe(false);
      expect(events.isJtiBlacklisted).toHaveBeenCalledTimes(1);
      expect(svc.stats().jti).toBe(1);
    });

    it('本层不做二次降级：异常原样上抛（fail-open 语义集中在 SessionEventsService 一处，非两套口径）', async () => {
      events.isJtiBlacklisted.mockRejectedValue(new Error('Redis 不可用'));
      await expect(svc.isJtiBlocked('j1')).rejects.toThrow('Redis 不可用');
      // SessionEventsService.isJtiBlacklisted 内部已 try/catch → 正常契约下永不抛错（见其单测）。
      // 这里锁住的是"降级责任单一归属"：本层再加一层 catch 会让 fail-open 出现两个真相来源。
    });

    it('SessionEventsService 缺失（@Optional 未注入）→ 视为未拉黑（不阻断鉴权）', async () => {
      const bare = new AccessGuardService(prisma as never);
      expect(await bare.isJtiBlocked('j1')).toBe(false);
    });

    it('invalidateSession 清空 jti 肯定缓存（登出后同一 token 立即重新判定）', async () => {
      await svc.isJtiBlocked('j1');
      expect(svc.stats().jti).toBe(1);
      svc.invalidateSession('s1');
      expect(svc.stats().jti).toBe(0);
    });

    it('onModuleInit 注册远端事件监听器（未初始化前不注册——避免半初始化实例收到事件）', () => {
      expect(events.hasListener).toBe(false);
      svc.onModuleInit();
      expect(events.hasListener).toBe(true);
    });
  });

  describe('M10-P1 SA-1/X-10：跨实例事件触发本地失效', () => {
    let events: ReturnType<typeof makeEvents>;
    beforeEach(() => {
      events = makeEvents();
      svc = new AccessGuardService(prisma as never, events as never);
      svc.onModuleInit();
    });

    it('session.revoked → 仅清该会话（另一个会话的肯定缓存保留，不做无谓全清）', async () => {
      prisma.session.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
      await svc.isSessionLive('s1');
      await svc.isSessionLive('s2');
      expect(svc.stats().sessions).toBe(2);

      events.emit({ type: 'session.revoked', sessionId: 's1' });

      expect(svc.stats().sessions).toBe(1);
      // 失效是**重查**而非直接判死：s1 下一次请求会真实查库（远端已把它标为撤销）
      prisma.session.findUnique.mockResolvedValue({ revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
      expect(await svc.isSessionLive('s1')).toBe(false);
    });

    it('user.sessions_revoked → 用户态 + 会话面整体清空（用户级撤销影响其多个会话）', async () => {
      prisma.user.findUnique.mockResolvedValue({ status: 'active' });
      prisma.session.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
      await svc.isUserActive('u1');
      await svc.isSessionLive('s1');
      await svc.isSessionLive('s2');

      events.emit({ type: 'user.sessions_revoked', userId: 'u1' });

      expect(svc.stats()).toEqual({ users: 0, sessions: 0, jti: 0 });
    });

    it('user.disabled → 该用户态失效（下一个请求重查 DB → 立即拒绝）', async () => {
      prisma.user.findUnique.mockResolvedValue({ status: 'active' });
      await svc.isUserActive('u1');
      expect(svc.stats().users).toBe(1);

      events.emit({ type: 'user.disabled', userId: 'u1' });

      expect(svc.stats().users).toBe(0);
      prisma.user.findUnique.mockResolvedValue({ status: 'disabled' });
      expect(await svc.isUserActive('u1')).toBe(false);
    });

    it('任何事件都清 jti 面（jti↔session 映射不在本层维护 → 保守清空）', async () => {
      await svc.isJtiBlocked('j1');
      expect(svc.stats().jti).toBe(1);
      events.emit({ type: 'session.revoked', sessionId: 's-other' });
      expect(svc.stats().jti).toBe(0);
    });
  });
});
