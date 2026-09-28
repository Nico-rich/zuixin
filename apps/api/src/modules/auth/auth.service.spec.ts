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
    markDeviceRevoked: vi.fn().mockResolvedValue(undefined), // M11-P2
    isSessionDeviceRevoked: vi.fn().mockResolvedValue(false), // M11-P2
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

  /** M11-P2：deviceId 清洗（服务端不信任其内容，但**必须**保证入库值干净且有界） */
  it('normalizeDeviceId：清洗控制字符/空白、截断超长、空值视为未提供', async () => {
    const { normalizeDeviceId, DEVICE_ID_MAX_LEN, DEVICE_ID_HEADER } = await import('./auth.constants');
    expect(DEVICE_ID_HEADER).toBe('x-device-id'); // 跨端契约名（客户端按此设置头）
    expect(normalizeDeviceId('device-1')).toBe('device-1');
    expect(normalizeDeviceId('  device-1  ')).toBe('device-1');            // 首尾空白
    expect(normalizeDeviceId(`dev${String.fromCharCode(1)}ice${String.fromCharCode(10)}-1`)).toBe('device-1'); // 控制字符（含 CR/LF）剥除
    expect(normalizeDeviceId('')).toBeUndefined();                          // 空 → 未提供
    expect(normalizeDeviceId('   ')).toBeUndefined();
    expect(normalizeDeviceId('\n\r')).toBeUndefined();
    expect(normalizeDeviceId(undefined)).toBeUndefined();
    expect(normalizeDeviceId(null)).toBeUndefined();
    expect(normalizeDeviceId(['a', 'b'])).toBeUndefined();                  // 重复头（数组）→ 未提供
    expect(normalizeDeviceId(123)).toBeUndefined();
    expect(normalizeDeviceId('x'.repeat(500))).toHaveLength(DEVICE_ID_MAX_LEN); // 超长截断（不拒绝登录）
  });
});

/**
 * M11-P2（D1-01/D1-10）：设备标识落库、会话管理（list/单会话下线/按设备下线）、token 轮换。
 */
describe('AuthService M11-P2：deviceId 落库', () => {
  it('登录带 deviceId → 写入 session.deviceId（清洗后）', async () => {
    const { svc, prisma } = makeAuth();
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });
    await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4', deviceId: ' device-A ' });
    expect(prisma.session.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deviceId: 'device-A' }),
    }));
  });

  it('登录不带 deviceId → deviceId 为 null（会话照常可用，只是不参与设备分组）', async () => {
    const { svc, prisma } = makeAuth();
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });
    await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4' });
    expect(prisma.session.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deviceId: null }),
    }));
  });

  it('非法 deviceId（纯控制字符）→ 视为未提供（不落库、不报错）', async () => {
    const { svc, prisma } = makeAuth();
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });
    await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4', deviceId: '\n\t' });
    expect(prisma.session.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deviceId: null }),
    }));
  });

  it('refresh 续期**继承**旧会话的 deviceId（否则设备分组会在刷新后丢失）', async () => {
    const { svc, prisma } = makeAuth();
    prisma.session.findUnique.mockResolvedValue({
      id: 's1', userId: 'u1', expiresAt: new Date(Date.now() + 3600_000), revokedAt: null, deviceId: 'device-A',
    });
    prisma.user.findUnique.mockResolvedValue(activeUser);
    await svc.refresh('raw', { ip: '1.2.3.4' });
    expect(prisma.session.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deviceId: 'device-A' }),
    }));
  });
});

describe('AuthService M11-P2：会话列表（listSessions）', () => {
  it('只回白名单字段 + current 标记；查询条件限定"本人 + 活跃"', async () => {
    const { svc, prisma } = makeAuth();
    const createdAt = new Date('2026-01-01T00:00:00Z');
    prisma.session.findMany.mockResolvedValue([
      { id: 's2', deviceId: 'dev-A', userAgent: 'UA2', ip: '10.0.0.2', createdAt, expiresAt: new Date(Date.now() + 1000) },
      { id: 's1', deviceId: null, userAgent: 'UA1', ip: '10.0.0.1', createdAt, expiresAt: new Date(Date.now() + 1000) },
    ]);

    const rows = await svc.listSessions('u1', 's2');

    const call = prisma.session.findMany.mock.calls[0][0] as { where: Record<string, unknown>; select: Record<string, unknown> };
    expect(call.where).toMatchObject({ userId: 'u1', revokedAt: null });
    // 敏感面：select 里**没有** tokenHash（也绝不回传任何 token）
    expect(Object.keys(call.select).sort()).toEqual(['createdAt', 'deviceId', 'expiresAt', 'id', 'ip', 'userAgent']);
    expect(rows[0].current).toBe(true);  // 发起本次请求的会话
    expect(rows[1].current).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('tokenHash');
  });

  it('无会话 → 空数组（不是错误）', async () => {
    const { svc, prisma } = makeAuth();
    prisma.session.findMany.mockResolvedValue([]);
    expect(await svc.listSessions('u1')).toEqual([]);
  });
});

describe('AuthService M11-P2：单会话下线（IDOR 口径）', () => {
  it('本人会话 → CAS 撤销 + 本进程失效 + 跨实例传播', async () => {
    const { svc, prisma, events, access } = makeAuth();
    prisma.session.findFirst.mockResolvedValue({ id: 's1' });
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    expect(await svc.revokeSession('u1', 's1')).toEqual({ revokedSessions: 1 });
    // CAS 条件带 userId：越权 id 在 SQL 层就不可能命中
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', userId: 'u1', revokedAt: null }, data: { revokedAt: expect.any(Date) },
    });
    expect(access.invalidateSession).toHaveBeenCalledWith('s1');
    expect(events.publish).toHaveBeenCalledWith({ type: 'session.revoked', sessionId: 's1', userId: 'u1' });
  });

  it('**他人会话 / 幽灵 id → 同码同文案 404**（防枚举；且零副作用：不撤销、不发布）', async () => {
    const { svc, prisma, events } = makeAuth();
    prisma.session.findFirst.mockResolvedValue(null); // 归属过滤后查不到（他人会话与不存在同形）
    await expect(svc.revokeSession('u1', 's-of-u2')).rejects.toMatchObject({ code: 'NOT_FOUND', message: '会话不存在' });
    expect(prisma.session.findFirst).toHaveBeenCalledWith({ where: { id: 's-of-u2', userId: 'u1' }, select: { id: true } });
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('已撤销会话 → 幂等 0（不报错、不重复发布事件）', async () => {
    const { svc, prisma, events } = makeAuth();
    prisma.session.findFirst.mockResolvedValue({ id: 's1' });
    prisma.session.updateMany.mockResolvedValue({ count: 0 });
    expect(await svc.revokeSession('u1', 's1')).toEqual({ revokedSessions: 0 });
    expect(events.publish).not.toHaveBeenCalled();
  });
});

describe('AuthService M11-P2：按设备下线（revokeDeviceSessions）', () => {
  it('撤销该设备全部活跃会话：CAS 批量撤销 + 每会话发布 session.revoked + 写设备下线标记', async () => {
    const { svc, prisma, events, access } = makeAuth();
    prisma.session.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);

    const r = await svc.revokeDeviceSessions('u1', 'dev-A');

    expect(r).toEqual({ revokedSessions: 2, sessionIds: ['s1', 's2'] });
    expect(prisma.session.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', deviceId: 'dev-A', revokedAt: null, expiresAt: { gt: expect.any(Date) } },
      select: { id: true },
    });
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', deviceId: 'dev-A', revokedAt: null }, data: { revokedAt: expect.any(Date) },
    });
    expect(access.invalidateSession).toHaveBeenCalledWith('s1');
    expect(access.invalidateSession).toHaveBeenCalledWith('s2');
    // 逐会话发布（载荷沿用既有契约，**不新增字段**）：远端按 sessionId 精确清会话面缓存
    expect(events.publish).toHaveBeenCalledWith({ type: 'session.revoked', sessionId: 's1', userId: 'u1' });
    expect(events.publish).toHaveBeenCalledWith({ type: 'session.revoked', sessionId: 's2', userId: 'u1' });
    // 原因标记：TTL = access token 上限寿命（保证任何仍在有效期内的 access token 都能看到它）
    expect(events.markDeviceRevoked).toHaveBeenCalledWith(['s1', 's2'], 900);
  });

  it('该设备无活跃会话 → 幂等 0（不撤销、不发布、不写标记）', async () => {
    const { svc, prisma, events } = makeAuth();
    prisma.session.findMany.mockResolvedValue([]);
    expect(await svc.revokeDeviceSessions('u1', 'dev-A')).toEqual({ revokedSessions: 0, sessionIds: [] });
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
    expect(events.markDeviceRevoked).not.toHaveBeenCalled();
  });

  it('deviceId 清洗后才参与查询（首尾空白/控制字符不会造成"查不到 → 幂等 0"的假象）', async () => {
    const { svc, prisma } = makeAuth();
    prisma.session.findMany.mockResolvedValue([{ id: 's1' }]);
    await svc.revokeDeviceSessions('u1', '  dev-A\n');
    expect(prisma.session.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deviceId: 'dev-A' }),
    }));
  });

  it('非法 deviceId（清洗后为空）→ VALIDATION_ERROR（不把"按空设备下线"解释成"下线全部"）', async () => {
    const { svc, prisma } = makeAuth();
    await expect(svc.revokeDeviceSessions('u1', '   ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.session.findMany).not.toHaveBeenCalled();
  });

  it('作用域恒为令牌主体：伪造 deviceId 只能影响自己的会话（查询恒带 userId）', async () => {
    const { svc, prisma } = makeAuth();
    prisma.session.findMany.mockResolvedValue([{ id: 's1' }]);
    await svc.revokeDeviceSessions('u1', 'dev-of-someone-else');
    const call = prisma.session.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where.userId).toBe('u1'); // 无跨租户面：deviceId 只是分组键
  });
});

describe('AuthService M11-P2：token 轮换（rotate）', () => {
  const liveSession = {
    id: 's1', userId: 'u1', expiresAt: new Date(Date.now() + 3600_000), revokedAt: null, deviceId: 'dev-A',
  };
  const claims = { sessionId: 's1', jti: 'jti-old', exp: Math.floor(Date.now() / 1000) + 600 };

  it('成功轮换：旧会话 CAS 撤销 + 旧 jti 拉黑 + 跨实例传播 + 新会话（**新 sid/新 jti**，deviceId 继承）', async () => {
    const { svc, prisma, events, access, jwt } = makeAuth();
    prisma.session.findUnique.mockResolvedValue(liveSession);
    prisma.user.findUnique.mockResolvedValue(activeUser);
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    const r = await svc.rotate('raw-refresh', claims, { ip: '1.2.3.4', userAgent: 'UA' });

    expect(r.accessToken).toBe('jwt-token');
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', revokedAt: null }, data: { revokedAt: expect.any(Date) },
    });
    expect(access.invalidateSession).toHaveBeenCalledWith('s1');
    expect(events.blacklistJti).toHaveBeenCalledWith('jti-old', expect.any(Number));
    const ttl = (events.blacklistJti.mock.calls[0] as unknown[])[1] as number;
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600); // TTL = 剩余寿命，绝不留比 token 更久的墓碑
    expect(events.publish).toHaveBeenCalledWith({ type: 'session.revoked', sessionId: 's1', userId: 'u1' });
    // 新会话：新 sid + deviceId 继承（轮换不改变设备分组）
    const created = prisma.session.create.mock.calls[0][0] as { data: { id: string; deviceId: string | null } };
    expect(created.data.id).not.toBe('s1');
    expect(created.data.deviceId).toBe('dev-A');
    const payload = jwt.signAsync.mock.calls[0][0] as { sid: string; jti: string };
    expect(payload.sid).toBe(created.data.id);
    expect(payload.jti).not.toBe('jti-old'); // jti 更换（旧 token 无法复用）
    expect(events.trackJti).toHaveBeenCalledWith('u1', payload.jti, expect.any(Number));
  });

  it('绑定性：access token 与 refresh token **不属于同一会话** → UNAUTHORIZED（且零副作用）', async () => {
    const { svc, prisma, events } = makeAuth();
    prisma.session.findUnique.mockResolvedValue(liveSession);
    await expect(svc.rotate('raw-refresh', { ...claims, sessionId: 's-other' }, { ip: '1.2.3.4' }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('无 refresh cookie / access 无 sid → UNAUTHORIZED（轮换必须同时持有两枚凭证）', async () => {
    const { svc, prisma } = makeAuth();
    await expect(svc.rotate(undefined, claims, { ip: 'x' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(svc.rotate('raw', { jti: 'j' }, { ip: 'x' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
  });

  it('refresh token 无效/已撤销/已过期 → UNAUTHORIZED', async () => {
    const { svc, prisma } = makeAuth();
    prisma.session.findUnique.mockResolvedValue(null);
    await expect(svc.rotate('raw', claims, { ip: 'x' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    prisma.session.findUnique.mockResolvedValue({ ...liveSession, revokedAt: new Date() });
    await expect(svc.rotate('raw', claims, { ip: 'x' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    prisma.session.findUnique.mockResolvedValue({ ...liveSession, expiresAt: new Date(Date.now() - 1000) });
    await expect(svc.rotate('raw', claims, { ip: 'x' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('账号不可用（禁用/删除）→ UNAUTHORIZED（不签发新凭证）', async () => {
    const { svc, prisma } = makeAuth();
    prisma.session.findUnique.mockResolvedValue(liveSession);
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, status: 'disabled' });
    await expect(svc.rotate('raw', claims, { ip: 'x' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('并发轮换：CAS 未命中的败者 → UNAUTHORIZED 且**不创建新会话**（旧 refresh 不可重放）', async () => {
    const { svc, prisma, jwt } = makeAuth();
    prisma.session.findUnique.mockResolvedValue(liveSession);
    prisma.user.findUnique.mockResolvedValue(activeUser);
    prisma.session.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.rotate('raw', claims, { ip: 'x' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('轮换不额外占用会话并发额度（先撤销旧会话 → 活跃数不增）', async () => {
    const { svc, prisma } = makeAuth();
    process.env.SESSION_MAX_CONCURRENT = '1';
    prisma.session.findUnique.mockResolvedValue(liveSession);
    prisma.user.findUnique.mockResolvedValue(activeUser);
    prisma.session.updateMany.mockResolvedValue({ count: 1 });
    prisma.session.count.mockResolvedValue(0); // 旧会话已撤销 → 余量足够

    await svc.rotate('raw', claims, { ip: 'x' });

    expect(prisma.session.create).toHaveBeenCalled();
    expect(prisma.session.findFirst).not.toHaveBeenCalled(); // 未触发挤占（不把别的设备踢下线）
    delete process.env.SESSION_MAX_CONCURRENT;
  });
});
