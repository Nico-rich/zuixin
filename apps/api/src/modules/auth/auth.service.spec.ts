import { describe, it, expect, vi } from 'vitest';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

function makeAuth() {
  const prisma = {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    session: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const jwt = { signAsync: vi.fn().mockResolvedValue('jwt-token') };
  const kv = { get: vi.fn().mockResolvedValue('0'), incr: vi.fn().mockResolvedValue(1), set: vi.fn(), setNX: vi.fn(), del: vi.fn() };
  const svc = new AuthService(prisma as never, jwt as never, kv as never, { ensurePersonalOrganization: vi.fn().mockResolvedValue({ id: 'org-1' }) } as never);
  return { svc, prisma, kv };
}

const activeUser = {
  id: 'u1', email: 'a@b.com', passwordHash: 'HASH', displayName: 'A',
  role: 'user', status: 'active',
};

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

  it('用户不存在 → 同样返回 UNAUTHORIZED（防枚举）', async () => {
    const { svc, prisma } = makeAuth();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(svc.login('nobody@b.com', 'x', { ip: '1.2.3.4', userAgent: 'ua' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
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
