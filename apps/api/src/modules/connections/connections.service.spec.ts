import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionsService } from './connections.service';

function makeService() {
  const prisma = {
    connection: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'c-new' }),
      update: vi.fn().mockResolvedValue({ id: 'c-old' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue({}),
    },
    oAuthState: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1' }) },
  };
  const provider = {
    name: 'mock',
    buildAuthorizeUrl: vi.fn((s: string) => `http://mock/authorize?state=${s}`),
    exchangeCode: vi.fn().mockResolvedValue({
      accessToken: 'acc', refreshToken: 'ref', expiresInSeconds: 3600, providerAccountId: 'acct-x',
    }),
    refreshToken: vi.fn(),
    revoke: vi.fn().mockResolvedValue(undefined),
  };
  const providers = { get: vi.fn((n: string) => (n === 'mock' ? provider : undefined)) };
  const credentials = {
    store: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue({ accessToken: 'acc' }),
    getRefreshToken: vi.fn().mockResolvedValue('ref'),
  };
  const svc = new ConnectionsService(prisma as never, providers as never, credentials as never);
  return { svc, prisma, providers, provider, credentials };
}

describe('ConnectionsService（M7-P2 OAuth 生命周期）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('start：state 落库（user+provider 绑定 + 10min 过期）→ authorizeUrl', async () => {
    const { svc, prisma } = makeService();
    const res = await svc.start('u1', 'mock', { projectId: null });
    expect(prisma.oAuthState.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 'u1', provider: 'mock',
        state: expect.any(String),
        expiresAt: expect.any(Date),
      }),
    }));
    expect(res.authorizeUrl).toContain('state=');
    expect(res.state).toBeTruthy();
  });

  it('start：不支持的 provider → 404 PROVIDER_UNSUPPORTED', async () => {
    const { svc } = makeService();
    await expect(svc.start('u1', 'shopify', { projectId: null })).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
  });

  it('callback：state 单次消费（条件更新）→ 交换 token → 新建 Connection + 凭证加密入库', async () => {
    const { svc, prisma, credentials } = makeService();
    prisma.oAuthState.findUnique.mockResolvedValue({
      id: 's1', userId: 'u1', provider: 'mock', projectId: null,
      state: 'st1', expiresAt: new Date(Date.now() + 60_000), usedAt: null,
    });
    const res = await svc.callback('u1', 'mock', { state: 'st1', code: 'code-1' });
    expect(prisma.oAuthState.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 's1', usedAt: null, expiresAt: expect.any(Object) },
      data: { usedAt: expect.any(Date) },
    }));
    expect(prisma.connection.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'u1', provider: 'mock', providerAccountId: 'acct-x', status: 'active' }),
    }));
    expect(credentials.store).toHaveBeenCalledWith('c-new', expect.objectContaining({ accessToken: 'acc' }));
    expect(res).toMatchObject({ id: 'c-new' });
  });

  it('callback：重复消费（count=0）→ 400 OAUTH_STATE_INVALID（重复 callback 不重复建连接）', async () => {
    const { svc, prisma } = makeService();
    prisma.oAuthState.findUnique.mockResolvedValue({
      id: 's1', userId: 'u1', provider: 'mock', projectId: null,
      state: 'st1', expiresAt: new Date(Date.now() + 60_000), usedAt: null,
    });
    prisma.oAuthState.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.callback('u1', 'mock', { state: 'st1', code: 'c' })).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    expect(prisma.connection.create).not.toHaveBeenCalled();
  });

  it('callback：state 过期 → 400 OAUTH_STATE_EXPIRED；他人 state → 400 OAUTH_STATE_INVALID', async () => {
    const { svc, prisma } = makeService();
    prisma.oAuthState.findUnique.mockResolvedValue({
      id: 's1', userId: 'u1', provider: 'mock', projectId: null,
      state: 'st1', expiresAt: new Date(Date.now() - 1000), usedAt: null,
    });
    await expect(svc.callback('u1', 'mock', { state: 'st1', code: 'c' })).rejects.toMatchObject({ code: 'OAUTH_STATE_EXPIRED' });
    prisma.oAuthState.findUnique.mockResolvedValue({
      id: 's1', userId: 'u2', provider: 'mock', projectId: null,
      state: 'st1', expiresAt: new Date(Date.now() + 60_000), usedAt: null,
    });
    await expect(svc.callback('u1', 'mock', { state: 'st1', code: 'c' })).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
  });

  it('callback reconnect：同 providerAccountId 已存在 → 复活（revoked→active + revokedAt 清空）+ 凭证替换，不新建', async () => {
    const { svc, prisma, credentials } = makeService();
    prisma.oAuthState.findUnique.mockResolvedValue({
      id: 's1', userId: 'u1', provider: 'mock', projectId: null,
      state: 'st1', expiresAt: new Date(Date.now() + 60_000), usedAt: null,
    });
    prisma.connection.findFirst.mockResolvedValue({ id: 'c-old', status: 'revoked' });
    const res = await svc.callback('u1', 'mock', { state: 'st1', code: 'c' });
    expect(prisma.connection.create).not.toHaveBeenCalled();
    expect(prisma.connection.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'c-old' },
      data: expect.objectContaining({ status: 'active', revokedAt: null }),
    }));
    expect(credentials.store).toHaveBeenCalledWith('c-old', expect.anything());
    expect(res).toMatchObject({ id: 'c-old' });
  });

  it('refresh：委托 CredentialService（竞态折叠在内）；本地 revoked → 409 不触远端', async () => {
    const { svc, prisma, credentials } = makeService();
    prisma.connection.findFirst.mockResolvedValue({ id: 'c1', status: 'revoked' });
    await expect(svc.refresh('u1', 'c1')).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
    expect(credentials.refresh).not.toHaveBeenCalled();
  });

  it('revoke：条件更新 active/expired → revoked + best-effort 远端吊销；重复 revoke → 409', async () => {
    const { svc, prisma, provider } = makeService();
    prisma.connection.findFirst.mockResolvedValue({ id: 'c1', status: 'active', provider: 'mock' });
    await svc.revoke('u1', 'c1');
    expect(prisma.connection.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'c1', userId: 'u1', status: { in: ['active', 'expired'] } },
      data: { status: 'revoked', revokedAt: expect.any(Date) },
    }));
    expect(provider.revoke).toHaveBeenCalledWith('ref');
    prisma.connection.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.revoke('u1', 'c1')).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
  });

  it('越权：他人连接 list/get/refresh/revoke 全部 404（防枚举）', async () => {
    const { svc, prisma } = makeService();
    prisma.connection.findFirst.mockResolvedValue(null);
    await expect(svc.get('u2', 'c1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.refresh('u2', 'c1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.revoke('u2', 'c1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.remove('u2', 'c1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
