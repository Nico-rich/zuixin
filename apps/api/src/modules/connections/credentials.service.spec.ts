import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { CredentialService } from './credentials.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

function makeService(config: string | { keys: Record<number, string>; currentVersion?: number } = TEST_KEY) {
  const crypto = new CryptoService(config);
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

/**
 * Pre-M9 C5：多实例安全。用**共享内存态假库**（两个凭证服务实例 = 模拟两个 API 实例，
 * 各自的进程内折叠表互不可见）验证 DB 条件更新兜底：并发 refresh 只有一个赢家发起远端刷新。
 */
function makeSharedDb(overrides: Partial<{ status: string; metadata: Record<string, unknown> | null }> = {}) {
  const crypto = new CryptoService(TEST_KEY);
  const state = {
    conn: {
      id: 'c1', provider: 'mock', status: overrides.status ?? 'active',
      metadata: overrides.metadata ?? null, updatedAt: new Date('2026-01-01T00:00:00Z'),
      lastSyncedAt: null as Date | null,
    },
    creds: [
      { id: 'cred-access-old', connectionId: 'c1', type: 'access_token', encryptedValue: crypto.encrypt('old_access'), expiresAt: null, createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: 'cred-refresh', connectionId: 'c1', type: 'refresh_token', encryptedValue: crypto.encrypt('REF_TOKEN'), expiresAt: null, createdAt: new Date('2026-01-01T00:00:00Z') },
    ] as Array<{ id: string; connectionId: string; type: string; encryptedValue: string; expiresAt: Date | null; createdAt: Date }>,
  };
  let seq = 0;
  const prisma: Record<string, unknown> = {
    connection: {
      findUnique: vi.fn(async (args: { where: { id: string }; select?: unknown }) =>
        args.where.id === state.conn.id ? { ...state.conn } : null),
      // CAS：status/updatedAt 任一失配 → count 0（真实 Postgres UPDATE 的谓词重检语义）
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (args.where.id !== state.conn.id) return { count: 0 };
        if (args.where.status !== undefined && state.conn.status !== args.where.status) return { count: 0 };
        if (args.where.updatedAt !== undefined
          && new Date(args.where.updatedAt as Date).getTime() !== state.conn.updatedAt.getTime()) return { count: 0 };
        if (args.data.status !== undefined) state.conn.status = args.data.status as string;
        if (args.data.metadata !== undefined) state.conn.metadata = args.data.metadata as Record<string, unknown> | null;
        state.conn.updatedAt = new Date(state.conn.updatedAt.getTime() + 1000); // @updatedAt 自动推进
        return { count: 1 };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        Object.assign(state.conn, args.data); // lastSyncedAt 等字段真实落盘（C5 输家判定依据）
        state.conn.updatedAt = new Date(state.conn.updatedAt.getTime() + 1000);
        return { ...state.conn };
      }),
    },
    credential: {
      findFirst: vi.fn(async (args: { where: { connectionId: string; type: string } }) => {
        const rows = state.creds.filter((c) => c.connectionId === args.where.connectionId && c.type === args.where.type);
        return rows.length ? rows[rows.length - 1] : null;
      }),
      deleteMany: vi.fn(async (args: { where: { connectionId: string; type: string } }) => {
        const before = state.creds.length;
        state.creds = state.creds.filter((c) => !(c.connectionId === args.where.connectionId && c.type === args.where.type));
        return { count: before - state.creds.length };
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        seq += 1;
        const row = { id: `cred-new-${seq}`, createdAt: new Date(Date.now() + seq), ...args.data } as (typeof state.creds)[number];
        state.creds.push(row);
        return row;
      }),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
  };
  const remote = {
    name: 'mock',
    refreshToken: vi.fn(async () => ({ accessToken: 'new_access', refreshToken: 'ref-next', expiresInSeconds: 3600, providerAccountId: 'a1' })),
    exchangeCode: vi.fn(), revoke: vi.fn(), buildAuthorizeUrl: vi.fn(),
  };
  const providers = { get: vi.fn(() => remote) };
  /** 每次调用 = 一个新的 API 实例（独立进程内折叠表） */
  const newInstance = () => new CredentialService(prisma as never, crypto, providers as never);
  return { prisma, state, remote, providers, newInstance, crypto };
}

describe('CredentialService（Pre-M9 C5：多实例安全——DB 条件更新兜底）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('两实例并发 refresh：DB 租约抢注胜出者独占远端刷新 → 仅一次 provider 调用，输家复用结果', async () => {
    const { newInstance, remote, state } = makeSharedDb();
    let releaseRemote!: (v: { accessToken: string; refreshToken: string; expiresInSeconds: number; providerAccountId: string }) => void;
    remote.refreshToken.mockImplementation(() => new Promise((res) => { releaseRemote = res as never; }));

    const a = newInstance();
    const b = newInstance(); // 模拟第二个 API 实例（无共享进程内状态）
    const pa = a.refresh('c1');
    await new Promise((r) => setTimeout(r, 10)); // A 抢注成功并进入远端调用
    const pb = b.refresh('c1');
    await new Promise((r) => setTimeout(r, 10));
    expect(remote.refreshToken).toHaveBeenCalledTimes(1); // B 未发起第二次远端刷新（等待赢家）

    releaseRemote({ accessToken: 'new_access', refreshToken: 'ref-next', expiresInSeconds: 3600, providerAccountId: 'a1' });
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra.accessToken).toBe('new_access');
    expect(rb.accessToken).toBe('new_access'); // 输家复用赢家结果（不是旧令牌）
    expect(remote.refreshToken).toHaveBeenCalledTimes(1);
    expect(state.creds.filter((c) => c.type === 'access_token')).toHaveLength(1); // 凭证行未被并发替换成多行
    expect(state.conn.metadata?.refreshLeaseUntil).toBeUndefined(); // 租约已释放
  });

  it('陈旧租约（TTL 已过）→ 可接管刷新（崩溃的实例不会永久阻塞）', async () => {
    const { newInstance, remote, state } = makeSharedDb({
      metadata: { refreshLeaseUntil: new Date(Date.now() - 60_000).toISOString(), refreshLeaseOwner: 'dead-instance' },
    });
    const res = await newInstance().refresh('c1');
    expect(res.accessToken).toBe('new_access');
    expect(remote.refreshToken).toHaveBeenCalledTimes(1);
    expect(state.conn.metadata?.refreshLeaseOwner).toBeUndefined();
  });

  it('对端持租约且刷新失败/卡死 → 有界等待后 409 CONNECTION_NOT_ACTIVE（绝不无限等待）', async () => {
    const prev = process.env.CONNECTION_REFRESH_WAIT_MS;
    process.env.CONNECTION_REFRESH_WAIT_MS = '120';
    try {
      const { newInstance, remote } = makeSharedDb({
        metadata: { refreshLeaseUntil: new Date(Date.now() + 30_000).toISOString(), refreshLeaseOwner: 'other-instance' },
      });
      await expect(newInstance().refresh('c1')).rejects.toMatchObject({ code: 'CONNECTION_NOT_ACTIVE' });
      expect(remote.refreshToken).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.CONNECTION_REFRESH_WAIT_MS;
      else process.env.CONNECTION_REFRESH_WAIT_MS = prev;
    }
  });
});

/**
 * M11-P1（D1-09）：`Credential.keyVersion` 恒为 1 的收口 ——
 * ① 写路径：`keyVersion` 与密文**同一条语句**写出，且取自密文自述版本（不可能失配）；
 * ② 读路径：版本裁决接线（未知版本 → KEY_VERSION_INVALID 既有行为；落后版本 → 可解但记欠账 + 节流 warn）。
 */
describe('CredentialService（M11-P1：keyVersion 落库 + 读路径密钥版本裁决）', () => {
  const KEY_V2 = Buffer.alloc(32, 42).toString('base64');
  const MULTI = { keys: { 1: TEST_KEY, 2: KEY_V2 }, currentVersion: 2 };
  const v1Encoder = new CryptoService({ keys: { 1: TEST_KEY }, currentVersion: 1 });
  /** 历史落库格式（3 段、无版本前缀）= 版本 1：存量数据的老形态 */
  const legacyV1 = (plain: string): string => v1Encoder.encrypt(plain).replace(/^v1\./, '');
  /** 格式合法但版本未配置（v9）→ 无法恢复明文 */
  const unknownVersion = (plain: string): string => v1Encoder.encrypt(plain).replace(/^v1\./, 'v9.');

  beforeEach(() => vi.clearAllMocks());

  it('写路径（单密钥）：keyVersion = 密文自述版本 = 1；access/refresh 两行都写', async () => {
    const { svc, crypto, prisma } = makeService();
    await svc.store('c1', { accessToken: 'a', refreshToken: 'r', expiresInSeconds: 60, providerAccountId: 'p' });
    const creates = (prisma.credential.create as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].data);
    expect(creates).toHaveLength(2);
    for (const row of creates) expect(row.keyVersion).toBe(crypto.keyVersionOf(row.encryptedValue));
    expect(creates.every((row) => row.keyVersion === 1)).toBe(true);
  });

  it('写路径（多密钥）：v2 环境写出 v2 密文 + keyVersion=2（不再恒为 1）', async () => {
    const { svc, crypto, prisma } = makeService(MULTI);
    await svc.store('c1', { accessToken: 'a', refreshToken: 'r', expiresInSeconds: 60, providerAccountId: 'p' });
    const creates = (prisma.credential.create as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].data);
    expect(creates).toHaveLength(2);
    for (const row of creates) {
      expect(row.keyVersion).toBe(2);
      expect(row.keyVersion).toBe(crypto.keyVersionOf(row.encryptedValue)); // 列与密文自述版本一致
      expect(crypto.needsRewrap(row.encryptedValue)).toBe(false);
    }
  });

  it('读路径（多密钥）：旧版本密文正常解密（不阻断轮换窗口），并计入迁移欠账 + warn（节流）', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { svc, prisma } = makeService(MULTI);
      prisma.credential.findFirst.mockImplementation(async (args: { where: { type: string } }) => ({
        encryptedValue: legacyV1(args.where.type === 'access_token' ? 'ACC' : 'REF'), expiresAt: null,
        keyVersion: 1,
      }));
      expect((await svc.getAccessToken('c1'))?.token).toBe('ACC'); // 旧版本仍可解（不抛错）
      expect(await svc.getRefreshToken('c1')).toBe('REF');
      expect(svc.staleKeyVersionStats()).toEqual({
        total: 2, byVersion: { '1': 2 }, currentKeyVersion: 2, configuredVersions: [1, 2],
      });
      expect(warn).toHaveBeenCalledTimes(1); // 首条立即告警，其后按节流（第 100/200… 次）
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('旧密钥版本'); // 可观测：欠账必须能被运维看到
      expect(logged).not.toContain('ACC'); // 绝不泄漏明文
      expect(logged).not.toContain(TEST_KEY); // 绝不泄漏密钥材料
      expect(logged).not.toContain(KEY_V2);
    } finally {
      warn.mockRestore();
    }
  });

  it('读路径（当前版本）：不计数、不告警', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { svc, crypto, prisma } = makeService(MULTI);
      prisma.credential.findFirst.mockResolvedValue({ encryptedValue: crypto.encrypt('NEW'), expiresAt: null, keyVersion: 2 });
      expect((await svc.getAccessToken('c1'))?.token).toBe('NEW');
      expect(svc.staleKeyVersionStats().total).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('读路径（版本未知/格式非法）：KEY_VERSION_INVALID（既有行为保持，绝不静默降级），且不污染欠账计数', async () => {
    const { svc, prisma } = makeService(MULTI);
    prisma.credential.findFirst.mockResolvedValue({ encryptedValue: unknownVersion('X'), expiresAt: null, keyVersion: 9 });
    await expect(svc.getAccessToken('c1')).rejects.toMatchObject({ code: ErrorCode.KEY_VERSION_INVALID });
    expect(svc.staleKeyVersionStats().total).toBe(0); // 没读成功就不算"读到了旧版本"

    prisma.credential.findFirst.mockResolvedValue({ encryptedValue: 'not-a-ciphertext', expiresAt: null, keyVersion: 1 });
    await expect(svc.getRefreshToken('c1')).rejects.toMatchObject({ code: ErrorCode.KEY_VERSION_INVALID });
  });

  it('refresh→store 后：新密文与 keyVersion 同步换代（读回新令牌且无欠账）', async () => {
    const { svc, crypto, prisma, mockProvider } = makeService(MULTI);
    prisma.credential.findFirst.mockResolvedValue({ encryptedValue: crypto.encrypt('REF_TOKEN'), expiresAt: null, keyVersion: 2 });
    const res = await svc.refresh('c1');
    expect(res.accessToken).toBe('new_access');
    expect(mockProvider.refreshToken).toHaveBeenCalledTimes(1);
    const creates = (prisma.credential.create as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].data);
    expect(creates.length).toBeGreaterThan(0);
    for (const row of creates) expect(row.keyVersion).toBe(crypto.keyVersionOf(row.encryptedValue));
    expect(svc.staleKeyVersionStats().total).toBe(0);
  });
});
