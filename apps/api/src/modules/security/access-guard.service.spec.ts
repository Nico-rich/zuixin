import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccessGuardService } from './access-guard.service';

function makePrisma() {
  return {
    user: { findUnique: vi.fn() },
    session: { findUnique: vi.fn() },
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

  it('stats 反映缓存规模（诊断面）', async () => {
    prisma.user.findUnique.mockResolvedValue({ status: 'active' });
    prisma.session.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
    await svc.isUserActive('u1');
    await svc.isSessionLive('s1');
    expect(svc.stats()).toEqual({ users: 1, sessions: 1 });
  });
});
