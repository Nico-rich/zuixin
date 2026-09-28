import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';
import type { SessionEventsService } from '../security/session-events.service';

/**
 * M10-P1 起 makeAuth 需要覆盖新增的 DB 面：
 * - `organization.findFirst`：登录路径组织禁用检查（X-21）；
 * - `session.count / findFirst / updateMany`：会话并发上限（SA-1）；
 * - `session.findMany`：登出/登出全部的跨实例事件载荷（SA-1/SA-4）。
 * `events`/`access` 两个可选注入默认给出 spy（断言跨实例传播与黑名单写入）。
 */
function makeAuth() {
  const prisma = {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    organization: {
      findFirst: vi.fn().mockResolvedValue(null), // 默认：无个人组织行 → 不做禁用判定（既有用例语义）
    },
    session: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const jwt = { signAsync: vi.fn().mockResolvedValue('jwt-token'), verifyAsync: vi.fn() };
  const kv = { get: vi.fn().mockResolvedValue('0'), incr: vi.fn().mockResolvedValue(1), set: vi.fn(), setNX: vi.fn(), del: vi.fn() };
  const events = {
    publish: vi.fn().mockResolvedValue(undefined),
    trackJti: vi.fn().mockResolvedValue(undefined),
    blacklistJti: vi.fn().mockResolvedValue(undefined),
    blacklistAllUserJtis: vi.fn().mockResolvedValue(0),
    isJtiBlacklisted: vi.fn().mockResolvedValue(false),
  };
  const access = { invalidateSession: vi.fn(), invalidateUser: vi.fn(), isJtiBlocked: vi.fn().mockResolvedValue(false) };
  const svc = new AuthService(
    prisma as never, jwt as never, kv as never,
    { ensurePersonalOrganization: vi.fn().mockResolvedValue({ id: 'org-1' }) } as never,
    undefined, // audit
    access as never,
    events as unknown as SessionEventsService,
  );
  return { svc, prisma, kv, events, access, jwt };
}

const activeUser = {
  id: 'u1', email: 'a@b.com', passwordHash: 'HASH', displayName: 'A',
  role: 'user', status: 'active',
};

afterEach(() => {
  // 只清本文件会改的两个键（整体替换 process.env 会波及 vitest 自身状态）
  delete process.env.SESSION_MAX_CONCURRENT;
  delete process.env.SESSION_CONCURRENCY_POLICY;
});

describe('AuthService.login', () => {
  it('成功登录返回 accessToken/refreshToken 并创建 session', async () => {
    const { svc, prisma } = makeAuth();
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });
    const r = await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4', userAgent: 'ua' });
    expect(r.accessToken).toBe('jwt-token');
    expect(r.refreshToken).toBeTruthy();
    expect(prisma.session.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'u1' }) }));
  });

  it('密码错误 → UNAUTHORIZED 且计数限流', async () => {
    const { svc, prisma, kv } = makeAuth();
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('right') });
    await expect(svc.login('a@b.com', 'wrong', { ip: '1.2.3.4', userAgent: 'ua' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(kv.incr).toHaveBeenCalled();
  });

  it('禁用用户 → FORBIDDEN', async () => {
    const { svc, prisma } = makeAuth();
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, status: 'disabled', passwordHash: await argon2.hash('secret123') });
    await expect(svc.login('a@b.com', 'secret123', { ip: '1.2.3.4', userAgent: 'ua' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('连续失败 ≥5 次 → RATE_LIMITED（不再查询用户）', async () => {
    const { svc, prisma, kv } = makeAuth();
    kv.get.mockResolvedValue('5');
    await expect(svc.login('a@b.com', 'x', { ip: '1.2.3.4', userAgent: 'ua' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('Pre-M9 G4：登录计数 Redis 读取失败 → 降级放行（fail-open，不因基础设施故障打死登录）', async () => {
    const { svc, prisma, kv } = makeAuth();
    kv.get.mockRejectedValue(new Error('Redis 操作超时（kv:get，>1500ms）'));
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });
    const r = await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4' });
    expect(r.accessToken).toBe('jwt-token'); // 放行
  });

  it('Pre-M9 G4：计数写入失败仍返回 UNAUTHORIZED（业务裁决不被基础设施故障改写）', async () => {
    const { svc, prisma, kv } = makeAuth();
    kv.incr.mockRejectedValue(new Error('Redis 操作超时（kv:incr，>1500ms）'));
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('right') });
    await expect(svc.login('a@b.com', 'wrong', { ip: '1.2.3.4' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('Pre-M9 G4：成功登录后计数清零失败 → 登录仍成功（正确密码绝不被 Redis 抖动拦下）', async () => {
    const { svc, prisma, kv } = makeAuth();
    kv.set.mockRejectedValue(new Error('Redis 操作超时（kv:set，>1500ms）'));
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });
    const r = await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4' });
    expect(r.accessToken).toBe('jwt-token');
  });

  it('用户不存在 → 同样返回 UNAUTHORIZED（防枚举）', async () => {
    const { svc, prisma } = makeAuth();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(svc.login('nobody@b.com', 'x', { ip: '1.2.3.4', userAgent: 'ua' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  describe('M10-P1 X-21：组织禁用态登录拒绝（ORG_DISABLED）', () => {
    it('个人组织 disabled → ORG_DISABLED 且不创建会话（凭证正确也不放行）', async () => {
      const { svc, prisma } = makeAuth();
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });
      prisma.organization.findFirst.mockResolvedValue({ status: 'disabled' });
      await expect(svc.login('a@b.com', 'secret123', { ip: '1.2.3.4', userAgent: 'ua' }))
        .rejects.toMatchObject({ code: 'ORG_DISABLED' });
      expect(prisma.session.create).not.toHaveBeenCalled();
    });

    it('个人组织 active（或不存在）→ 正常登录', async () => {
      const { svc, prisma } = makeAuth();
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });
      prisma.organization.findFirst.mockResolvedValue({ status: 'active' });
      const r = await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4', userAgent: 'ua' });
      expect(r.accessToken).toBe('jwt-token');
    });

    it('禁用判定发生在密码校验之后（错误密码仍是 UNAUTHORIZED，不泄漏组织状态）', async () => {
      const { svc, prisma } = makeAuth();
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('right') });
      prisma.organization.findFirst.mockResolvedValue({ status: 'disabled' });
      await expect(svc.login('a@b.com', 'wrong', { ip: '1.2.3.4', userAgent: 'ua' }))
        .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('M10-P1 SA-1：会话并发数上限', () => {
    it('未达上限 → 不做任何挤占（count < limit）', async () => {
      const { svc, prisma } = makeAuth();
      process.env.SESSION_MAX_CONCURRENT = '3';
      prisma.session.count.mockResolvedValue(2);
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });
      await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4' });
      expect(prisma.session.findFirst).not.toHaveBeenCalled();
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('默认策略 evict-oldest：达到上限时挤掉最旧会话（用户始终能登录）', async () => {
      const { svc, prisma, events, access } = makeAuth();
      process.env.SESSION_MAX_CONCURRENT = '2';
      prisma.session.count.mockResolvedValue(2);
      prisma.session.findFirst.mockResolvedValue({ id: 's-oldest' });
      prisma.session.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });

      const r = await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4' });

      expect(r.accessToken).toBe('jwt-token'); // 登录成功（不是拒绝）
      // CAS 条件撤销：where 带 revokedAt: null（并发下绝不重复挤同一条）
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { id: 's-oldest', revokedAt: null }, data: { revokedAt: expect.any(Date) },
      });
      // 本地缓存 + 跨实例传播（被挤掉的设备立即下线）
      expect(access.invalidateSession).toHaveBeenCalledWith('s-oldest');
      expect(events.publish).toHaveBeenCalledWith({ type: 'session.revoked', sessionId: 's-oldest', userId: 'u1' });
      expect(prisma.session.create).toHaveBeenCalled();
    });

    it('CAS 未命中（并发登录已挤掉该会话）→ SESSION_CONCURRENCY_EXCEEDED（保守拒绝，绝不放任突破上限）', async () => {
      const { svc, prisma } = makeAuth();
      process.env.SESSION_MAX_CONCURRENT = '1';
      prisma.session.count.mockResolvedValue(1);
      prisma.session.findFirst.mockResolvedValue({ id: 's-oldest' });
      prisma.session.updateMany.mockResolvedValue({ count: 0 }); // 竞态：已被别处撤销
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });

      await expect(svc.login('a@b.com', 'secret123', { ip: '1.2.3.4' }))
        .rejects.toMatchObject({ code: 'SESSION_CONCURRENCY_EXCEEDED' });
      expect(prisma.session.create).not.toHaveBeenCalled();
    });

    it('显式策略 reject：超限直接拒绝新登录（不静默下线任何设备）', async () => {
      const { svc, prisma } = makeAuth();
      process.env.SESSION_MAX_CONCURRENT = '2';
      process.env.SESSION_CONCURRENCY_POLICY = 'reject';
      prisma.session.count.mockResolvedValue(2);
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });

      await expect(svc.login('a@b.com', 'secret123', { ip: '1.2.3.4' }))
        .rejects.toMatchObject({ code: 'SESSION_CONCURRENCY_EXCEEDED' });
      expect(prisma.session.findFirst).not.toHaveBeenCalled();
      expect(prisma.session.create).not.toHaveBeenCalled();
    });

    it('SESSION_MAX_CONCURRENT=0 → 不限制（显式关闭治理）', async () => {
      const { svc, prisma } = makeAuth();
      process.env.SESSION_MAX_CONCURRENT = '0';
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });
      await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4' });
      expect(prisma.session.count).not.toHaveBeenCalled();
    });
  });

  describe('M10-P1 SA-4：jti 签发与记账', () => {
    it('签发的 access token 带 jti，且记账到 SessionEventsService（供登出全部精确拉黑）', async () => {
      const { svc, prisma, jwt, events } = makeAuth();
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });
      await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4' });

      const payload = jwt.signAsync.mock.calls[0][0] as { sid?: string; jti?: string; sub: string };
      expect(payload.sub).toBe('u1');
      expect(typeof payload.sid).toBe('string');
      expect(typeof payload.jti).toBe('string');
      expect(events.trackJti).toHaveBeenCalledWith('u1', payload.jti, expect.any(Number));
      // TTL 语义：记账的过期时刻在未来（否则黑名单墓碑会被提前丢弃）
      const exp = (events.trackJti.mock.calls[0] as unknown[])[2] as number;
      expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('每次签发的 jti 唯一（轮换/登出全部可按 token 粒度拉黑）', async () => {
      const { svc, prisma, jwt } = makeAuth();
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });
      await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4' });
      await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4' });
      const a = jwt.signAsync.mock.calls[0][0] as { jti: string };
      const b = jwt.signAsync.mock.calls[1][0] as { jti: string };
      expect(a.jti).not.toBe(b.jti);
    });
  });
});

describe('AuthService.refresh', () => {
  const goodSession = { id: 's1', userId: 'u1', expiresAt: new Date(Date.now() + 3600_000), revokedAt: null, tokenHash: 'H' };

  it('有效 refresh token → 轮换（旧会话吊销 + 新会话创建）', async () => {
    const { svc, prisma } = makeAuth();
    prisma.session.findUnique.mockResolvedValue(goodSession);
    prisma.user.findUnique.mockResolvedValue(activeUser);
    const r = await svc.refresh('raw-refresh', { ip: '1.2.3.4', userAgent: 'ua' });
    expect(prisma.session.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { revokedAt: expect.any(Date) } });
    expect(prisma.session.create).toHaveBeenCalled();
    expect(r.accessToken).toBe('jwt-token');
  });

  it('已吊销 → UNAUTHORIZED', async () => {
    const { svc, prisma } = makeAuth();
    prisma.session.findUnique.mockResolvedValue({ ...goodSession, revokedAt: new Date() });
    await expect(svc.refresh('raw', { ip: 'x', userAgent: 'ua' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('空 token → UNAUTHORIZED', async () => {
    const { svc } = makeAuth();
    await expect(svc.refresh('', { ip: 'x', userAgent: 'ua' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('AuthService.logout', () => {
  it('吊销对应会话', async () => {
    const { svc, prisma } = makeAuth();
    await svc.logout('raw-refresh');
    expect(prisma.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { revokedAt: expect.any(Date) } }));
  });

  it('M10-P1 SA-4：登出同时拉黑本次 access token 的 jti（TTL = 剩余寿命）+ 跨实例传播', async () => {
    const { svc, prisma, events, access } = makeAuth();
    prisma.session.findMany.mockResolvedValue([{ id: 's1', userId: 'u1' }]);
    const exp = Math.floor(Date.now() / 1000) + 600;

    await svc.logout('raw-refresh', 's1', { sessionId: 's1', jti: 'jti-1', exp });

    expect(events.blacklistJti).toHaveBeenCalledWith('jti-1', expect.any(Number));
    const ttl = (events.blacklistJti.mock.calls[0] as unknown[])[1] as number;
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600); // TTL ≤ 剩余寿命，绝不留比 token 更久的墓碑
    expect(access.invalidateSession).toHaveBeenCalledWith('s1');
    expect(events.publish).toHaveBeenCalledWith({ type: 'session.revoked', sessionId: 's1', userId: 'u1' });
  });

  it('无 refresh 也无 access sid → 不发任何写操作', async () => {
    const { svc, prisma, events } = makeAuth();
    await svc.logout(undefined, undefined);
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });
});

describe('AuthService.logoutAll（M10-P1 SA-4/X-20）', () => {
  it('撤销全部会话 + 拉黑全部有效 jti + 发布用户级事件', async () => {
    const { svc, prisma, events, access } = makeAuth();
    prisma.session.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    prisma.session.updateMany.mockResolvedValue({ count: 2 });
    events.blacklistAllUserJtis.mockResolvedValue(3);
    const exp = Math.floor(Date.now() / 1000) + 300;

    const r = await svc.logoutAll('u1', { sessionId: 's1', jti: 'jti-cur', exp });

    expect(r).toEqual({ revokedSessions: 2, blacklistedJtis: 3 });
    expect(access.invalidateSession).toHaveBeenCalledWith('s1');
    expect(access.invalidateSession).toHaveBeenCalledWith('s2');
    expect(events.blacklistJti).toHaveBeenCalledWith('jti-cur', expect.any(Number)); // 当前 token 兜底拉黑
    expect(events.blacklistAllUserJtis).toHaveBeenCalledWith('u1');
    expect(events.publish).toHaveBeenCalledWith({ type: 'user.sessions_revoked', userId: 'u1' });
  });
});

describe('AuthService.me', () => {
  it('返回用户信息', async () => {
    const { svc, prisma } = makeAuth();
    prisma.user.findUnique.mockResolvedValue(activeUser);
    const r = await svc.me('u1');
    expect(r.user.email).toBe('a@b.com');
  });

  it('用户不存在 → UNAUTHORIZED', async () => {
    const { svc, prisma } = makeAuth();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(svc.me('nope')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('AuthService.accessTokenClaims', () => {
  it('提取 sid/jti/exp；无 token 或验签失败 → null（不抛错）', async () => {
    const { svc, jwt } = makeAuth();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', sid: 's1', jti: 'j1', exp: 1234 });
    expect(await svc.accessTokenClaims('tok')).toEqual({ sessionId: 's1', jti: 'j1', exp: 1234 });
    expect(await svc.sessionIdFromAccessToken('tok')).toBe('s1');

    jwt.verifyAsync.mockRejectedValue(new Error('invalid signature'));
    expect(await svc.accessTokenClaims('bad')).toBeNull();
    expect(await svc.sessionIdFromAccessToken(undefined)).toBeNull();
  });
});

describe('auth.constants 会话治理配置', () => {
  it('sessionMaxConcurrent / sessionConcurrencyPolicy 读取 env（默认 5 / evict-oldest）', async () => {
    const constants = await import('./auth.constants');
    expect(constants.sessionMaxConcurrent({})).toBe(5);
    expect(constants.sessionMaxConcurrent({ SESSION_MAX_CONCURRENT: '9' })).toBe(9);
    expect(constants.sessionMaxConcurrent({ SESSION_MAX_CONCURRENT: 'abc' })).toBe(5);
    expect(constants.sessionConcurrencyPolicy({})).toBe('evict-oldest');
    expect(constants.sessionConcurrencyPolicy({ SESSION_CONCURRENCY_POLICY: 'reject' })).toBe('reject');
    expect(constants.sessionConcurrencyPolicy({ SESSION_CONCURRENCY_POLICY: 'whatever' })).toBe('evict-oldest');
  });
});
