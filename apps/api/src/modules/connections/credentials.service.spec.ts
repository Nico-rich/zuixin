import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CredentialService } from './credentials.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

function makeService() {
  const crypto = new CryptoService(TEST_KEY);
  const prisma = {
    connection: {
      findUnique: vi.fn().mockResolvedValue({ id: 'c1', provider: 'mock', status: 'active' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    credential: {
      findFirst: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<void>) => cb(prisma)),
  };
  const mockProvider = {
    name: 'mock',
    refreshToken: vi.fn().mockResolvedValue({
      accessToken: 'new_access', refreshToken: 'ref1', expiresInSeconds: 3600, providerAccountId: 'acct-1',
    }),
    exchangeCode: vi.fn(),
    revoke: vi.fn().mockResolvedValue(undefined),
    buildAuthorizeUrl: vi.fn(),
  };
  const providers = { get: vi.fn(() => mockProvider) };
  const svc = new CredentialService(prisma as never, crypto, providers as never);
  return { svc, crypto, prisma, providers, mockProvider };
}

describe('CredentialService（M7-P2 加密 at rest + refresh 竞态）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('store：access/refresh 全部 AES-256-GCM 密文落库（DB 密文 ≠ 明文），连接 expiresAt 同步', async () => {
    const { svc, prisma } = makeService();
    await svc.store('c1', { accessToken: 'plain_access', refreshToken: 'plain_refresh', expiresInSeconds: 3600, providerAccountId: 'a1' });
    const creates = (prisma.credential.create as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].data);
    const access = creates.find((c: { type: string }) => c.type === 'access_token');
    const refresh = creates.find((c: { type: string }) => c.type === 'refresh_token');
    expect(access.encryptedValue).not.toContain('plain_access'); // 密文 ≠ 明文
    expect(refresh.encryptedValue).not.toContain('plain_refresh');
    expect(prisma.connection.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'c1' },
      data: expect.objectContaining({ expiresAt: expect.any(Date) }),
    }));
  });

  it('getAccessToken/getRefreshToken：服务端解密还原明文（明文只在本服务内存出现）', async () => {
    const { svc, crypto, prisma } = makeService();
    prisma.credential.findFirst.mockImplementation(async (args: { where: { type: string } }) => ({
      encryptedValue: crypto.encrypt(args.where.type === 'access_token' ? 'ACC' : 'REF'),
      expiresAt: null,
    }));
    expect((await svc.getAccessToken('c1'))?.token).toBe('ACC');
    expect(await svc.getRefreshToken('c1')).toBe('REF');
  });

  it('refresh 竞态折叠：并发 refresh 共享同一 in-flight → 远端只调用一次', async () => {
    const { svc, prisma, mockProvider, crypto } = makeService();
    prisma.credential.findFirst.mockResolvedValue({ encryptedValue: crypto.encrypt('REF_TOKEN'), expiresAt: null });
    let release!: () => void;
    mockProvider.refreshToken.mockImplementation(() => new Promise((res) => {
      release = () => res({ accessToken: 'new_access', refreshToken: 'ref1', expiresInSeconds: 3600, providerAccountId: 'a1' });
    }));
    const p1 = svc.refresh('c1');
    const p2 = svc.refresh('c1');
    await new Promise((r) => setTimeout(r, 10)); // 让 doRefresh 推进到远端调用（多个微任务跳）
    release();
    await Promise.all([p1, p2]);
    expect(mockProvider.refreshToken).toHaveBeenCalledTimes(1); // 远端单次调用
  });

  it('refresh 失败（远端吊销 PROVIDER_AUTH）→ connection 标记 expired 后原错误上抛', async () => {
    const { svc, prisma, mockProvider, crypto } = makeService();
    prisma.credential.findFirst.mockResolvedValue({ encryptedValue: crypto.encrypt('REF_TOKEN'), expiresAt: null });
    mockProvider.refreshToken.mockRejectedValue(new AppError(ErrorCode.PROVIDER_AUTH, '吊销'));
    await expect(svc.refresh('c1')).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
    expect(prisma.connection.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'c1', status: 'active' },
      data: { status: 'expired' },
    }));
  });

  it('refresh：本地 revoked → 409 CONNECTION_REVOKED（绝不触碰远端）', async () => {
    const { svc, prisma, mockProvider } = makeService();
    prisma.connection.findUnique.mockResolvedValue({ id: 'c1', provider: 'mock', status: 'revoked' });
    await expect(svc.refresh('c1')).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
    expect(mockProvider.refreshToken).not.toHaveBeenCalled();
  });

  it('refresh：无 refresh token → 409 CONNECTION_NOT_REFRESHABLE', async () => {
    const { svc, prisma, mockProvider } = makeService();
    prisma.credential.findFirst.mockResolvedValue(null);
    await expect(svc.refresh('c1')).rejects.toMatchObject({ code: 'CONNECTION_NOT_REFRESHABLE' });
    expect(mockProvider.refreshToken).not.toHaveBeenCalled();
  });
});
