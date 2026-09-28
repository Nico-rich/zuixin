import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    isSessionDeviceRevoked: vi.fn().mockResolvedValue(false), // M11-P2
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

  afterEach(() => {
    delete process.env.SECURITY_GUARD_CACHE_MAX_ENTRIES;
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

  /**
   * M11-P2（D1-01）：设备下线后的 401 需要**可区分的原因**（DEVICE_REVOKED vs UNAUTHORIZED）。
   * 本层只做"原因查询"，拒绝结论恒来自 DB 会话状态（调用点在后）。
   */
  describe('M11-P2：设备下线原因（DEVICE_REVOKED 的判定面）', () => {
    let events: ReturnType<typeof makeEvents>;
    beforeEach(() => {
      events = makeEvents();
      svc = new AccessGuardService(prisma as never, events as never);
    });

    it('远端/本进程标记为"设备下线" → true；否则 false', async () => {
      events.isSessionDeviceRevoked.mockResolvedValue(true);
      expect(await svc.isSessionDeviceRevoked('s1')).toBe(true);
      events.isSessionDeviceRevoked.mockResolvedValue(false);
      expect(await svc.isSessionDeviceRevoked('s2')).toBe(false);
      expect(events.isSessionDeviceRevoked).toHaveBeenCalledWith('s1');
    });

    it('SessionEventsService 缺失（@Optional 未注入）→ false（退化回通用 UNAUTHORIZED，不影响拒绝本身）', async () => {
      const bare = new AccessGuardService(prisma as never);
      expect(await bare.isSessionDeviceRevoked('s1')).toBe(false);
    });
  });

  /**
   * M11-P2（D1-11）：三个缓存的**容量上限**。
   * M10 审计：原实现只受 TTL 约束（TTL 只影响"命中"，不影响"驻留"）→ 条目随历史用户/会话/jti 单调增长。
   * 策略：整表清空重建（简单有界；丢失的肯定结论只值一次重新查库）。
   */
  describe('M11-P2：缓存容量上限（有界策略）', () => {
    it('默认上限 5000（env SECURITY_GUARD_CACHE_MAX_ENTRIES 可覆盖；非法值回落默认）', () => {
      expect(new AccessGuardService(prisma as never).maxEntries).toBe(5000);
      process.env.SECURITY_GUARD_CACHE_MAX_ENTRIES = '7';
      expect(new AccessGuardService(prisma as never).maxEntries).toBe(7);
      process.env.SECURITY_GUARD_CACHE_MAX_ENTRIES = 'abc';
      expect(new AccessGuardService(prisma as never).maxEntries).toBe(5000);
      process.env.SECURITY_GUARD_CACHE_MAX_ENTRIES = '0';
      expect(new AccessGuardService(prisma as never).maxEntries).toBe(5000); // 0/负 = 非法（不可配成"无缓存"）
    });

    it('userStatusCache：达到上限后整表清空并写入新条目（size 恒 ≤ 上限，绝不无界增长）', async () => {
      process.env.SECURITY_GUARD_CACHE_MAX_ENTRIES = '3';
      svc = new AccessGuardService(prisma as never);
      prisma.user.findUnique.mockResolvedValue({ status: 'active' });
      for (let i = 0; i < 10; i += 1) await svc.isUserActive(`u${i}`);
      expect(svc.stats().users).toBeLessThanOrEqual(3);
      expect(svc.stats().users).toBeGreaterThan(0);
      // 清空后写入的条目**没有丢**：最后一次查询的结论仍被缓存（命中 → 不再查库）
      const calls = prisma.user.findUnique.mock.calls.length;
      expect(await svc.isUserActive('u9')).toBe(true);
      expect(prisma.user.findUnique.mock.calls.length).toBe(calls);
    });

    it('sessionCache：达到上限后整表清空（size 恒 ≤ 上限）', async () => {
      process.env.SECURITY_GUARD_CACHE_MAX_ENTRIES = '2';
      svc = new AccessGuardService(prisma as never);
      prisma.session.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
      for (let i = 0; i < 8; i += 1) await svc.isSessionLive(`s${i}`);
      expect(svc.stats().sessions).toBeLessThanOrEqual(2);
      expect(await svc.isSessionLive('s7')).toBe(true); // 最近一次仍被记住
    });

    it('jtiOkCache：达到上限后整表清空（jti 面按 token 计，增长最快）', async () => {
      process.env.SECURITY_GUARD_CACHE_MAX_ENTRIES = '2';
      const events = makeEvents();
      svc = new AccessGuardService(prisma as never, events as never);
      for (let i = 0; i < 8; i += 1) await svc.isJtiBlocked(`j${i}`);
      expect(svc.stats().jti).toBeLessThanOrEqual(2);
      // 清空是**保守**方向：丢失肯定缓存只会多查一次 Redis，绝不改变放行/拒绝结论
      expect(await svc.isJtiBlocked('j7')).toBe(false);
    });

    it('上限内不触发清空（清空只在越界那一刻发生，稳态零额外开销）', async () => {
      process.env.SECURITY_GUARD_CACHE_MAX_ENTRIES = '3';
      svc = new AccessGuardService(prisma as never);
      prisma.user.findUnique.mockResolvedValue({ status: 'active' });
      await svc.isUserActive('u1');
      await svc.isUserActive('u2');
      await svc.isUserActive('u3');
      expect(svc.stats().users).toBe(3); // 恰好等于上限：未清空（>= 判定只在**新增**越界时生效）
      await svc.isUserActive('u1');
      expect(svc.stats().users).toBe(3);
    });
  });
});
