import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProvidersAdminService } from './providers-admin.service';

/**
 * M13+（模型配置页）Provider 管理面单测（离线）。红线断言：
 * - RBAC = 仅平台管理员（DB 权威 role='admin'；绝不采信 token 声明）；
 * - apiKey **只写不回显**（加密落库、明文零泄漏——update data/审计 metadata/响应投影都无明文）；
 * - 不可变面（type/adapter/name）strict 拒绝；baseUrl 写时 SSRF 同步判定（mock 允许 ''）；
 * - 写库成功 → 按 type 热 refresh（只调对应 manager）；失败路径零副作用（不写库/不审计/不 refresh）。
 */
function makeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'seed-llm-mock', name: '本地Mock', type: 'llm', adapter: 'mock', baseUrl: '',
    enabled: true, priority: 100, timeoutMs: 60000, apiKeyEncrypted: '',
    healthStatus: 'healthy', retryConfig: null,
    createdAt: new Date(0), updatedAt: new Date(0),
    models: [{ id: 'seed-model-mock-echo', name: 'Mock Echo', apiModelId: 'mock-echo', type: 'llm', enabled: true, priority: 1, isDefault: true, contextWindow: null, inputPrice: 0, outputPrice: 0, unitPrice: 0, capabilities: {} }],
    ...over,
  };
}

function makeService(over: {
  role?: string;
  row?: ReturnType<typeof makeRow> | null;
  status?: { loaded: boolean; degradedReason: string | null };
} = {}) {
  const row = over.row === undefined ? makeRow() : over.row;
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ role: over.role ?? 'admin' })) },
    provider: {
      findMany: vi.fn(async () => (row ? [row] : [])),
      findUnique: vi.fn(async () => row),
      findUniqueOrThrow: vi.fn(async () => row),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row!, ...data })),
    },
  };
  const audit = {
    write: vi.fn(async (_args: {
      userId: string; action: string; targetType: string; targetId: string;
      organizationId: string | null; result: string; metadata: Record<string, unknown>;
    }) => undefined),
  };
  const crypto = {
    // 真实密文（AES-GCM base64）绝不含明文——mock 同样不含（只留长度线索便于断言调用发生）
    encrypt: vi.fn((plain: string) => `v1.cipher:${Buffer.byteLength(plain)}b`),
    keyVersionOf: vi.fn(() => 1),
  };
  const status = over.status ?? { loaded: true, degradedReason: null };
  const manager = {
    refresh: vi.fn(async () => undefined),
    providerStatus: vi.fn(() => status),
  };
  const svc = new ProvidersAdminService(
    prisma as never, audit as never, crypto as never,
    manager as never, manager as never, manager as never, manager as never,
  );
  return { svc, prisma, audit, crypto, manager };
}

describe('ProvidersAdminService RBAC（平台管理员闸门）', () => {
  it('role=admin → 放行；role=user → 403 FORBIDDEN（DB 权威，绝不采信 token）', async () => {
    const admin = makeService();
    expect(await admin.svc.isPlatformAdmin('u1')).toBe(true);
    await expect(admin.svc.list()).resolves.toBeDefined();

    const user = makeService({ role: 'user' });
    await expect(user.svc.assertPlatformAdmin('u1')).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('仅平台管理员') });
    await expect(user.svc.patch('u1', 'seed-llm-mock', { enabled: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(user.prisma.provider.update).not.toHaveBeenCalled();
    expect(user.audit.write).not.toHaveBeenCalled();
    expect(user.manager.refresh).not.toHaveBeenCalled();
  });
});

describe('ProvidersAdminService PATCH 校验面（写库前裁决；失败零副作用）', () => {
  it('未知 id → 404', async () => {
    const h = makeService({ row: null });
    await expect(h.svc.patch('u1', 'nope', { enabled: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.prisma.provider.update).not.toHaveBeenCalled();
  });

  it('空补丁 → 400；不可变面（type/adapter/name）→ 400（strict 结构性拒绝）', async () => {
    const h = makeService();
    for (const bad of [{}, { type: 'image' }, { adapter: 'openai-compatible' }, { name: 'x' }, { apiKeyEncrypted: 'x' }]) {
      await expect(h.svc.patch('u1', 'seed-llm-mock', bad)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(h.prisma.provider.update).not.toHaveBeenCalled();
    expect(h.audit.write).not.toHaveBeenCalled();
  });

  it('priority/timeoutMs 越界 → 400', async () => {
    const h = makeService();
    for (const bad of [{ priority: -1 }, { priority: 1.5 }, { timeoutMs: 999 }, { timeoutMs: 700_000 }]) {
      await expect(h.svc.patch('u1', 'seed-llm-mock', bad)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(h.prisma.provider.update).not.toHaveBeenCalled();
  });

  it('baseUrl：https 公网 → 放行；http（未开 PROVIDER_ALLOW_HTTP）→ 400；凭证/内网/非 URL → 400；mock 空串 → 放行；非 mock 空串 → 400', async () => {
    const h = makeService();
    delete process.env.PROVIDER_ALLOW_HTTP;
    await expect(h.svc.patch('u1', 'seed-llm-mock', { baseUrl: 'https://api.example.com/v1' })).resolves.toBeDefined();
    for (const bad of ['http://api.example.com/v1', 'ftp://x', 'https://user:pass@api.example.com', 'https://localhost/v1', 'https://10.0.0.1/v1', 'not-a-url']) {
      await expect(h.svc.patch('u1', 'seed-llm-mock', { baseUrl: bad })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('baseUrl 不安全') });
    }
    await expect(h.svc.patch('u1', 'seed-llm-mock', { baseUrl: '' })).resolves.toBeDefined(); // mock 允许空

    const real = makeService({ row: makeRow({ id: 'seed-llm-OpenAI', name: 'OpenAI', adapter: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', enabled: false }) });
    await expect(real.svc.patch('u1', 'seed-llm-OpenAI', { baseUrl: '' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('仅 mock adapter 允许空') });
  });
});

describe('ProvidersAdminService PATCH 写路径（加密/热刷新/审计）', () => {
  beforeEach(() => { delete process.env.PROVIDER_ALLOW_HTTP; });
  afterEach(() => { delete process.env.PROVIDER_ALLOW_HTTP; });

  it('enabled:false → 写库 + 对应 manager refresh 被调', async () => {
    const h = makeService();
    await h.svc.patch('u1', 'seed-llm-mock', { enabled: false });
    expect(h.prisma.provider.update).toHaveBeenCalledWith({ where: { id: 'seed-llm-mock' }, data: { enabled: false } });
    expect(h.manager.refresh).toHaveBeenCalledTimes(1);
  });

  it('apiKey 空串/缺省 → update data 无 apiKeyEncrypted（只写语义，不改密文）', async () => {
    const h = makeService();
    await h.svc.patch('u1', 'seed-llm-mock', { apiKey: '  ', priority: 5 });
    expect(h.prisma.provider.update.mock.calls[0][0].data).toEqual({ priority: 5 });
    expect(h.crypto.encrypt).not.toHaveBeenCalled();
  });

  it('apiKey 非空 → crypto.encrypt 落库，update data/审计 metadata 均无明文', async () => {
    const h = makeService();
    await h.svc.patch('u1', 'seed-llm-mock', { apiKey: 'sk-secret-123' });
    expect(h.crypto.encrypt).toHaveBeenCalledWith('sk-secret-123');
    expect(h.prisma.provider.update.mock.calls[0][0].data).toEqual({ apiKeyEncrypted: 'v1.cipher:13b' });
    expect(JSON.stringify(h.prisma.provider.update.mock.calls[0])).not.toContain('sk-secret-123');
    const audited = h.audit.write.mock.calls[0][0];
    expect(audited.action).toBe('provider.update');
    expect(audited.targetType).toBe('provider');
    expect(audited.targetId).toBe('seed-llm-mock');
    expect(audited.metadata.keyChanged).toBe(true);
    expect(audited.metadata.changed).toEqual(['apiKey']);
    expect(JSON.stringify(audited.metadata)).not.toContain('sk-secret-123');
  });

  it('审计失败不阻断配置生效（best-effort）', async () => {
    const h = makeService();
    h.audit.write.mockRejectedValueOnce(new Error('audit down'));
    await expect(h.svc.patch('u1', 'seed-llm-mock', { enabled: false })).resolves.toBeDefined();
    expect(h.prisma.provider.update).toHaveBeenCalledTimes(1);
  });

  it('refresh 失败不掩盖配置结果（warn + 配置已生效）', async () => {
    const h = makeService();
    h.manager.refresh.mockRejectedValueOnce(new Error('refresh down'));
    await expect(h.svc.patch('u1', 'seed-llm-mock', { enabled: false })).resolves.toBeDefined();
  });
});

describe('ProvidersAdminService list 投影（绝不回显 Key）', () => {
  it('hasKey 布尔 + keyVersion 来自自描述密文；无 apiKeyEncrypted 字段；degradedReason/loaded 取自 manager', async () => {
    const h = makeService({
      row: makeRow({ apiKeyEncrypted: 'v2.xxx.yyy.zzz', enabled: true }),
      status: { loaded: true, degradedReason: null },
    });
    const out = await h.svc.list();
    expect(out).toHaveLength(1);
    expect(out[0].hasKey).toBe(true);
    expect(out[0].keyVersion).toBe(1);
    expect(out[0].loaded).toBe(true);
    expect(out[0].degradedReason).toBeNull();
    expect(out[0].models[0].id).toBe('seed-model-mock-echo');
    expect(JSON.stringify(out)).not.toContain('apiKeyEncrypted');
    expect(JSON.stringify(out)).not.toContain('xxx.yyy');
  });

  it('degradedReason 透出（加载失败归因可见，但绝不含密文）', async () => {
    const h = makeService({ status: { loaded: false, degradedReason: '未知 adapter: x' } });
    const out = await h.svc.list();
    expect(out[0].loaded).toBe(false);
    expect(out[0].degradedReason).toBe('未知 adapter: x');
  });

  it('managedByExtension 只回布尔（retryConfig.extensionId 存在 → true）', async () => {
    const h = makeService({ row: makeRow({ id: 'p-ext', name: 'X', retryConfig: { extensionId: 'e1', orgHash: 'secret' } }) });
    const out = await h.svc.list();
    expect(out[0].managedByExtension).toBe(true);
    expect(JSON.stringify(out)).not.toContain('orgHash');
  });
});
