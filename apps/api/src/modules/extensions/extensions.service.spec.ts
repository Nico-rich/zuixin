import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { ExtensionsService } from './extensions.service';
import { ToolRegistry } from '../../core/tools/tool-registry.service';
import { Tool, ToolContext } from '../../core/tools/tool.types';
import { CryptoService } from '../../core/crypto/crypto.service';
import { checksumOf, parseManifest, signChecksum } from './manifest';

// 平台签名/加密同源密钥（ENCRYPTION_KEY）；缺失时补一个合法 32 字节 base64（不覆盖真实配置）
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'dGVzdC1rZXktMzItYnl0ZXMtbG9uZy1hYmNkZWZnaGk=';
const PLATFORM_KEY = process.env.ENCRYPTION_KEY!;

const CTX: ToolContext = {
  userId: 'u1', projectId: 'p1', conversationId: 'c1', messageId: 'm1',
  agentRunId: 'r1', agentRunStepId: 's1', toolCallId: 't1', idempotencyKey: 'k1', signal: new AbortController().signal,
};

function toolManifest(slug: string, block: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'],
    tool: {
      name: `ext.${slug}.search`, description: '检索封装', baseTool: 'knowledge.search',
      paramConstraints: { topK: { min: 1, max: 5 } }, ...block,
    },
  };
}

function agentManifest(slug: string) {
  return {
    manifestVersion: 1, kind: 'agent', permissions: ['agent.run'],
    agent: {
      name: `${slug}-agent`, description: '扩展 Agent', systemPrompt: '你是 {{extension.name}}。',
      tools: ['knowledge.search'],
    },
  };
}

function providerManifest(slug: string) {
  return {
    manifestVersion: 1, kind: 'provider', permissions: ['provider.call'],
    provider: {
      name: `provider-${slug}`, adapter: 'openai-compatible', baseUrl: 'https://api.example.com/v1',
      models: [{ name: 'gpt-x', apiModelId: 'gpt-x-0613', type: 'llm' }],
    },
  };
}

/** 已发布版本行（含真实 checksum + 签名） */
function publishedVersion(manifest: unknown, slug: string, over: Record<string, unknown> = {}) {
  const parsed = parseManifest(manifest, { slug });
  return {
    id: 'v1', extensionId: 'e1', version: 1, status: 'published',
    manifest: parsed.manifest, checksum: parsed.checksum, signature: signChecksum(parsed.checksum, PLATFORM_KEY),
    ...over,
  };
}

function makeHarness() {
  const baseExecute = vi.fn().mockResolvedValue({ count: 0, results: [] });
  const registry = new ToolRegistry();
  registry.register({
    name: 'knowledge.search', description: '平台检索', permission: 'read',
    inputSchema: z.strictObject({ query: z.string(), topK: z.number().optional() }),
    execute: baseExecute,
  });
  registry.register({
    name: 'external_action.execute', description: '外部副作用', permission: 'destructive',
    inputSchema: z.strictObject({ action: z.string() }),
    execute: vi.fn(),
  });

  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'u1', role: 'user' }) },
    extension: {
      findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'e1', ...data })),
      update: vi.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
    },
    extensionVersion: {
      findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: `v${data.version}`, ...data })),
      update: vi.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      aggregate: vi.fn().mockResolvedValue({ _max: { version: 1 } }),
    },
    extensionPermission: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    extensionInstallation: {
      findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockImplementation(({ create }) => Promise.resolve({ id: 'i1', ...create })),
      update: vi.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
      delete: vi.fn().mockResolvedValue({}),
    },
    agent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'a1', ...data })),
      update: vi.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentVersion: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: `av${data.version}`, ...data })),
      aggregate: vi.fn().mockResolvedValue({ _max: { version: 0 } }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
    },
    provider: {
      findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'pr1', ...data })),
      update: vi.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
    },
    model: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'm1', ...data })),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  };
  const authz = { authorize: vi.fn().mockResolvedValue('owner') };
  const crypto = new CryptoService(PLATFORM_KEY);
  // M8-P8：provider baseUrl 安装时增加 DNS 层 SSRF 校验；单测注入确定性解析器（DNS 边界替换点），
  // 规则本身的覆盖见 src/modules/security/ssrf-guard.spec.ts
  const dnsResolver = async (): Promise<string[]> => ['93.184.216.34'];
  const svc = new ExtensionsService(prisma as never, authz as never, crypto, registry, dnsResolver);
  return { svc, prisma, authz, registry, baseExecute };
}

describe('M8-P6 ExtensionsService（创建/版本状态机/权限）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create：draft 扩展 + v1 draft 版本 + 权限行物化（每 kind 权限来自 manifest）', async () => {
    const { svc, prisma } = makeHarness();
    const r = await svc.create('u1', { organizationId: 'org1', name: '检索扩展', slug: 'demo-ext', kind: 'tool', manifest: toolManifest('demo-ext') });
    expect(r.extension.status).toBe('draft');
    expect(r.extension.kind).toBe('tool');
    expect(prisma.extensionVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ version: 1, status: 'draft' }),
    }));
    expect(prisma.extensionPermission.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { versionId_name: { versionId: 'v1', name: 'tool.execute' } },
    }));
  });

  it('create：平台级扩展需平台管理员（非 admin → FORBIDDEN）；组织级需 agent.write', async () => {
    const { svc, prisma, authz } = makeHarness();
    await expect(svc.create('u1', { organizationId: null, name: 'x', slug: 'demo-ext', kind: 'tool', manifest: toolManifest('demo-ext') }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    prisma.user.findUnique.mockResolvedValue({ id: 'admin', role: 'admin' });
    await expect(svc.create('admin', { organizationId: null, name: 'x', slug: 'demo-ext', kind: 'tool', manifest: toolManifest('demo-ext') }))
      .resolves.toBeTruthy();

    authz.authorize.mockRejectedValueOnce(Object.assign(new Error('无权访问该组织'), { code: 'FORBIDDEN' }));
    await expect(svc.create('u1', { organizationId: 'org1', name: 'x', slug: 'demo-ext', kind: 'tool', manifest: toolManifest('demo-ext') }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(authz.authorize).toHaveBeenCalledWith('u1', 'org1', 'agent.write');
  });

  it('create：baseTool 必须存在且可包装（破坏性/财务/外部副作用工具拒绝）', async () => {
    const { svc } = makeHarness();
    await expect(svc.create('u1', { organizationId: 'org1', name: 'x', slug: 'demo-ext', kind: 'tool', manifest: toolManifest('demo-ext', { baseTool: 'nope.tool' }) }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.create('u1', { organizationId: 'org1', name: 'x', slug: 'demo-ext', kind: 'tool', manifest: toolManifest('demo-ext', { baseTool: 'external_action.execute' }) }))
      .rejects.toThrowError(/不可被扩展包装/);
    // paramConstraints 引用不存在的参数 → 拒绝
    await expect(svc.create('u1', { organizationId: 'org1', name: 'x', slug: 'demo-ext', kind: 'tool', manifest: toolManifest('demo-ext', { paramConstraints: { nope: { min: 1 } } }) }))
      .rejects.toThrowError(/不存在的参数/);
  });

  it('publish：draft → published + HMAC 签名 + 旧 published 归档 + 扩展状态 published', async () => {
    const { svc, prisma } = makeHarness();
    const parsed = parseManifest(toolManifest('demo-ext'), { slug: 'demo-ext' });
    prisma.extension.findUnique.mockResolvedValue({ id: 'e1', organizationId: 'org1', slug: 'demo-ext', kind: 'tool', status: 'draft' });
    prisma.extensionVersion.findFirst.mockResolvedValue({ id: 'v1', extensionId: 'e1', version: 1, status: 'draft', manifest: parsed.manifest, checksum: 'stale', signature: null });
    await svc.publish('u1', 'e1');
    expect(prisma.extensionVersion.updateMany).toHaveBeenCalledWith({ where: { extensionId: 'e1', status: 'published' }, data: { status: 'archived' } });
    const updateArg = prisma.extensionVersion.update.mock.calls[0][0] as { data: { status: string; checksum: string; signature: string } };
    expect(updateArg.data.status).toBe('published');
    expect(updateArg.data.checksum).toBe(parsed.checksum);
    expect(updateArg.data.signature).toBe(signChecksum(parsed.checksum, PLATFORM_KEY));
    expect(prisma.extension.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: { status: 'published' } });
  });

  it('状态机：只有 draft 可发布；archived 后不可发布（绝不逆向）', async () => {
    const { svc, prisma } = makeHarness();
    prisma.extension.findUnique.mockResolvedValue({ id: 'e1', organizationId: 'org1', slug: 'demo-ext', kind: 'tool', status: 'published' });
    prisma.extensionVersion.findFirst.mockResolvedValue({ id: 'v1', extensionId: 'e1', status: 'published' });
    await expect(svc.publish('u1', 'e1')).rejects.toThrowError(/只有 draft 版本可发布/);

    prisma.extension.findUnique.mockResolvedValue({ id: 'e1', organizationId: 'org1', slug: 'demo-ext', kind: 'tool', status: 'archived' });
    await expect(svc.publish('u1', 'e1')).rejects.toThrowError(/已归档/);
    await expect(svc.deprecate('u1', 'e1')).rejects.toThrowError(/只有 published 扩展可弃用/);
    await expect(svc.update('u1', 'e1', { name: 'y' })).rejects.toThrowError(/已归档扩展不可再修改/);
  });

  it('update：published 扩展 → 新版本 draft（旧版本行不被修改）', async () => {
    const { svc, prisma } = makeHarness();
    prisma.extension.findUnique.mockResolvedValue({ id: 'e1', organizationId: 'org1', slug: 'demo-ext', kind: 'tool', status: 'published' });
    prisma.extensionVersion.findFirst.mockResolvedValue(null); // 无 draft
    prisma.extensionVersion.aggregate.mockResolvedValue({ _max: { version: 1 } });
    await svc.update('u1', 'e1', { manifest: toolManifest('demo-ext', { description: 'v2 描述' }) });
    expect(prisma.extensionVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ version: 2, status: 'draft', signature: null }),
    }));
    // 绝不 UPDATE published 行
    for (const call of prisma.extensionVersion.update.mock.calls) {
      expect((call[0] as { data: Record<string, unknown> }).data).not.toHaveProperty('status');
    }
  });
});

describe('M8-P6 安装 / 版本锁定 / 物化', () => {
  beforeEach(() => vi.clearAllMocks());

  function withToolInstall(harness: ReturnType<typeof makeHarness>, opts: { version?: Record<string, unknown> } = {}) {
    const { prisma } = harness;
    const version = opts.version ?? publishedVersion(toolManifest('demo-ext'), 'demo-ext');
    const ext = { id: 'e1', organizationId: 'org1', slug: 'demo-ext', name: '检索扩展', description: 'd', kind: 'tool', status: 'published' };
    prisma.extension.findUnique.mockResolvedValue(ext);
    prisma.extensionVersion.findFirst.mockResolvedValue(version);
    prisma.extensionInstallation.upsert.mockResolvedValue({ id: 'i1', organizationId: 'org1', extensionId: 'e1', versionId: version.id, status: 'enabled' });
    // reconcile 视图
    prisma.extensionInstallation.findMany.mockResolvedValue([{ id: 'i1', organizationId: 'org1', extensionId: 'e1', versionId: version.id, status: 'enabled' }]);
    prisma.extension.findMany.mockResolvedValue([ext]);
    prisma.extensionVersion.findMany.mockResolvedValue([version]);
    return { ext, version };
  }

  it('install：版本锁定（installation.versionId = 指定版本）+ 权限行物化 + 工具注册进 ToolRegistry', async () => {
    const harness = makeHarness();
    const { svc, prisma, registry } = harness;
    const { version } = withToolInstall(harness);
    const r = await svc.install('u1', 'e1', { organizationId: 'org1' });
    expect(r.installation.versionId).toBe(version.id);
    expect(prisma.extensionInstallation.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ versionId: version.id }),
    }));
    expect(registry.get('ext.demo-ext.search')).toBeTruthy();
    expect(svc.registeredToolNames()).toEqual(['ext.demo-ext.search']);
  });

  it('install：未发布版本不可安装；checksum 被篡改 / 签名无效 → 拒绝', async () => {
    const harness = makeHarness();
    const { svc, prisma } = harness;
    withToolInstall(harness, { version: publishedVersion(toolManifest('demo-ext'), 'demo-ext', { status: 'draft', signature: null }) });
    await expect(svc.install('u1', 'e1', { organizationId: 'org1' })).rejects.toThrowError(/未发布版本不可安装/);

    vi.clearAllMocks();
    withToolInstall(harness, { version: publishedVersion(toolManifest('demo-ext'), 'demo-ext', { checksum: 'deadbeef' }) });
    await expect(svc.install('u1', 'e1', { organizationId: 'org1' })).rejects.toThrowError(/校验和不一致/);

    vi.clearAllMocks();
    withToolInstall(harness, { version: publishedVersion(toolManifest('demo-ext'), 'demo-ext', { signature: 'a'.repeat(64) }) });
    await expect(svc.install('u1', 'e1', { organizationId: 'org1' })).rejects.toThrowError(/签名无效/);
  });

  it('install：非成员 → FORBIDDEN（组织 RBAC；跨组织扩展不可见）', async () => {
    const harness = makeHarness();
    const { svc, prisma, authz } = harness;
    withToolInstall(harness);
    authz.authorize.mockRejectedValueOnce(Object.assign(new Error('无权访问该组织'), { code: 'FORBIDDEN' }));
    await expect(svc.install('u9', 'e1', { organizationId: 'org9' })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // 组织私有扩展对其它组织不可见 → 404
    prisma.extension.findUnique.mockResolvedValue({ id: 'e1', organizationId: 'org-other', slug: 'demo-ext', kind: 'tool', status: 'published' });
    await expect(svc.install('u1', 'e1', { organizationId: 'org1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('包装执行：paramConstraints 非法拒绝；合法输入原样透传（ToolContext 不变）', async () => {
    const harness = makeHarness();
    const { svc, registry, baseExecute } = harness;
    withToolInstall(harness);
    await svc.install('u1', 'e1', { organizationId: 'org1' });
    const wrapped = registry.get('ext.demo-ext.search')!;
    expect(wrapped.permission).toBe('read'); // 绝不提升权限

    await expect(wrapped.execute({ query: '品牌', topK: 99 }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(baseExecute).not.toHaveBeenCalled();

    const input = { query: '品牌', topK: 3 };
    await wrapped.execute(input, CTX);
    expect(baseExecute).toHaveBeenCalledWith(input, CTX);
  });

  it('disable → 注册表移除；enable → 重新注册；uninstall → 移除 + 物化资源标记失效', async () => {
    const harness = makeHarness();
    const { svc, prisma, registry } = harness;
    withToolInstall(harness);
    await svc.install('u1', 'e1', { organizationId: 'org1' });
    expect(registry.has('ext.demo-ext.search')).toBe(true);

    prisma.extensionInstallation.findUnique.mockResolvedValue({ id: 'i1', organizationId: 'org1', extensionId: 'e1', versionId: 'v1', status: 'enabled' });
    // reconcile 只查 status=enabled（禁用后该查询为空）
    prisma.extensionInstallation.findMany.mockResolvedValue([]);
    await svc.setEnabled('u1', 'e1', 'org1', false);
    expect(registry.has('ext.demo-ext.search')).toBe(false);

    prisma.extensionInstallation.findMany.mockResolvedValue([{ id: 'i1', organizationId: 'org1', extensionId: 'e1', versionId: 'v1', status: 'enabled' }]);
    await svc.setEnabled('u1', 'e1', 'org1', true);
    expect(registry.has('ext.demo-ext.search')).toBe(true);

    prisma.extensionInstallation.findMany.mockResolvedValue([]);
    await svc.uninstall('u1', 'e1', 'org1');
    expect(registry.has('ext.demo-ext.search')).toBe(false);
    expect(prisma.extensionInstallation.delete).toHaveBeenCalledWith({ where: { id: 'i1' } });
  });

  it('deprecate / archive：扩展下线 → 工具移除（状态机绝不逆向）', async () => {
    const harness = makeHarness();
    const { svc, prisma, registry } = harness;
    withToolInstall(harness);
    await svc.install('u1', 'e1', { organizationId: 'org1' });
    expect(registry.has('ext.demo-ext.search')).toBe(true);
    prisma.extension.findMany.mockResolvedValue([]); // 扩展已非 published
    await svc.deprecate('u1', 'e1');
    expect(registry.has('ext.demo-ext.search')).toBe(false);
  });

  it('reconcile 幂等：重复调用不重复注册（重启自愈路径）', async () => {
    const harness = makeHarness();
    const { svc, registry, prisma } = harness;
    withToolInstall(harness);
    await svc.install('u1', 'e1', { organizationId: 'org1' });
    await svc.reconcile();
    await svc.reconcile();
    expect(svc.registeredToolNames()).toEqual(['ext.demo-ext.search']);
    expect(registry.list().filter((t) => t.name.startsWith('ext.')).length).toBe(1);
    expect(prisma.extensionInstallation.findMany).toHaveBeenCalled();
  });

  it('agent 类：物化为组织私有 Agent（scope=organization）+ 已发布 AgentVersion + activeVersionId', async () => {
    const harness = makeHarness();
    const { svc, prisma } = harness;
    const version = publishedVersion(agentManifest('brand'), 'brand');
    const ext = { id: 'e2', organizationId: 'org1', slug: 'brand', name: '品牌助手', description: 'd', kind: 'agent', status: 'published' };
    prisma.extension.findUnique.mockResolvedValue(ext);
    prisma.extensionVersion.findFirst.mockResolvedValue(version);
    prisma.extensionInstallation.upsert.mockResolvedValue({ id: 'i2', organizationId: 'org1', extensionId: 'e2', versionId: 'v1', status: 'enabled' });
    prisma.agent.findUnique.mockResolvedValue(null);

    const r = await svc.install('u1', 'e2', { organizationId: 'org1' });
    expect(r.materialized.kind).toBe('agent');
    expect(prisma.agent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'custom', scope: 'organization', organizationId: 'org1', enabled: true }),
    }));
    expect(prisma.agentVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'published', tools: ['knowledge.search'], systemPrompt: '你是 品牌助手。' }),
    }));
    expect(prisma.agent.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { activeVersionId: 'av1' } });
  });

  it('provider 类：必须由安装 config 提供 apiKey（manifest 绝不携带）；加密落库 + installation.config 脱敏', async () => {
    const harness = makeHarness();
    const { svc, prisma } = harness;
    const version = publishedVersion(providerManifest('p'), 'p');
    const ext = { id: 'e3', organizationId: 'org1', slug: 'p', name: '第三方 provider', description: 'd', kind: 'provider', status: 'published' };
    prisma.extension.findUnique.mockResolvedValue(ext);
    prisma.extensionVersion.findFirst.mockResolvedValue(version);
    prisma.extensionInstallation.upsert.mockResolvedValue({ id: 'i3', organizationId: 'org1', extensionId: 'e3', versionId: 'v1', status: 'enabled' });

    await expect(svc.install('u1', 'e3', { organizationId: 'org1' })).rejects.toThrowError(/必须由组织提供 config.apiKey/);

    await svc.install('u1', 'e3', { organizationId: 'org1', config: { apiKey: 'sk-live-secret-1234', region: 'cn' } });
    const createArg = prisma.provider.create.mock.calls[0][0] as { data: { adapter: string; apiKeyEncrypted: string; baseUrl: string } };
    expect(createArg.data.adapter).toBe('openai-compatible');
    expect(createArg.data.baseUrl).toBe('https://api.example.com/v1');
    expect(createArg.data.apiKeyEncrypted).not.toContain('sk-live-secret-1234');
    expect(new CryptoService(PLATFORM_KEY).decrypt(createArg.data.apiKeyEncrypted)).toBe('sk-live-secret-1234');
    expect(prisma.model.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ apiModelId: 'gpt-x-0613', type: 'llm', enabled: true }),
    }));
    // installation.config 绝不落库密钥（取最后一次成功安装的调用）
    const upsertArg = prisma.extensionInstallation.upsert.mock.calls.at(-1)![0] as { create: { config: Record<string, unknown> } };
    expect(upsertArg.create.config).toEqual({ region: 'cn' });
  });

  it('provider 类：重新启用（enable）复用已加密落库的密钥（不重复索取明文，也不覆盖为空）', async () => {
    const harness = makeHarness();
    const { svc, prisma } = harness;
    const version = publishedVersion(providerManifest('p'), 'p');
    const ext = { id: 'e3', organizationId: 'org1', slug: 'p', name: '第三方 provider', description: 'd', kind: 'provider', status: 'published' };
    const stored = new CryptoService(PLATFORM_KEY).encrypt('sk-already-stored');
    prisma.extension.findUnique.mockResolvedValue(ext);
    prisma.extensionVersion.findFirst.mockResolvedValue(version);
    prisma.extensionVersion.findUnique.mockResolvedValue(version); // setEnabled 以锁定版本重新物化
    prisma.provider.findFirst.mockResolvedValue({ id: 'prov1', name: `provider-p [ext:p:${'0'.repeat(8)}]`, apiKeyEncrypted: stored });
    prisma.extensionInstallation.findUnique.mockResolvedValue({ id: 'i3', organizationId: 'org1', extensionId: 'e3', versionId: 'v1', status: 'disabled' });

    await svc.setEnabled('u1', 'e3', 'org1', true);

    const updateArg = prisma.provider.update.mock.calls.at(-1)![0] as { data: { apiKeyEncrypted: string; enabled: boolean } };
    expect(updateArg.data.enabled).toBe(true);
    expect(updateArg.data.apiKeyEncrypted).toBe(stored); // 原样复用密文（绝不回显/重签明文）
  });
});
