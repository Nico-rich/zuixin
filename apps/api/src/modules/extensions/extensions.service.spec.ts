import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { ExtensionsService } from './extensions.service';
import { ToolRegistry } from '../../core/tools/tool-registry.service';
import { Tool, ToolContext } from '../../core/tools/tool.types';
import { CryptoService } from '../../core/crypto/crypto.service';
import { checksumOf, parseManifest, signChecksum } from './manifest';
import { resolveEffectiveAgentTools } from './effective-agent-tools';

// Pre-M9 F4：唯一实现 resolveEffectiveAgentTools 的调用可观测（包装真实实现 → 既有用例行为不变）
vi.mock('./effective-agent-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./effective-agent-tools')>();
  return { ...actual, resolveEffectiveAgentTools: vi.fn(actual.resolveEffectiveAgentTools) };
});

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

/** F4：指定 agent 工具清单（用于越权/未知工具用例） */
function agentManifestWith(slug: string, tools: string[]) {
  const m = agentManifest(slug);
  return { ...m, agent: { ...m.agent, tools } };
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
  // F4：可包装权限面（generate/write）+ 不可包装权限面（financial）各一，用于交集断言
  registry.register({
    name: 'image.generate', description: '生成', permission: 'generate',
    inputSchema: z.strictObject({ prompt: z.string() }), execute: vi.fn(),
  });
  registry.register({
    name: 'billing.charge', description: '财务', permission: 'financial',
    inputSchema: z.strictObject({ amount: z.number() }), execute: vi.fn(),
  });
  registry.register({
    name: 'artifact.create', description: '制品', permission: 'write',
    inputSchema: z.strictObject({ title: z.string() }), execute: vi.fn(),
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
    // M10-P14（D16）：扩展组织白名单（缺省空 = 对所有组织开放，既有用例语义不变）
    extensionOrgAllowlist: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockImplementation(({ create }) => Promise.resolve({ id: 'al-1', ...create })),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    organization: {
      findFirst: vi.fn().mockResolvedValue({ id: 'org1', status: 'active' }),
      findUnique: vi.fn().mockResolvedValue({ id: 'org1', status: 'active', isPersonal: false, deletedAt: null }),
      update: vi.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
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
  const authz = {
    authorize: vi.fn().mockResolvedValue('owner'),
    // M10-P14：白名单 owner 判定读成员行（含组织治理态）
    membership: vi.fn().mockResolvedValue({ role: 'owner', orgStatus: 'active' }),
  };
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

/**
 * Pre-M9 F4：kind=agent 工具白名单（权限提升）。
 * effective = 请求清单 ∩ 平台注册表 ∩ 可包装权限面 ∩ 扩展/组织策略面（交集，绝不并集）；
 * 声明期 fail-closed 拒绝 + 物化期剔除兜底（审计日志 + AgentVersion.config 持久化剔除清单），
 * 三条路径（install 声明校验 / setEnabled 重放 / materializeAgent 物化）共用唯一实现。
 */
describe('Pre-M9 F4 agent 工具白名单（effective tools 交集）', () => {
  beforeEach(() => vi.clearAllMocks());

  /** agent 类扩展安装/启用视图（锁定版本含指定工具清单） */
  function withAgentInstall(harness: ReturnType<typeof makeHarness>, tools: string[]) {
    const { prisma } = harness;
    const version = publishedVersion(agentManifestWith('brand', tools), 'brand');
    const ext = { id: 'e2', organizationId: 'org1', slug: 'brand', name: '品牌助手', description: 'd', kind: 'agent', status: 'published' };
    prisma.extension.findUnique.mockResolvedValue(ext);
    prisma.extensionVersion.findFirst.mockResolvedValue(version);
    prisma.extensionVersion.findUnique.mockResolvedValue(version); // setEnabled 以锁定版本重新物化
    prisma.extensionInstallation.upsert.mockResolvedValue({ id: 'i2', organizationId: 'org1', extensionId: 'e2', versionId: 'v1', status: 'enabled' });
    prisma.agent.findUnique.mockResolvedValue(null);
    return { ext, version };
  }

  it('声明期：install 的 parse 校验走同一 helper → 越权工具直接拒绝（VALIDATION_ERROR），且不产生任何物化/落库', async () => {
    const harness = makeHarness();
    const { svc, prisma } = harness;
    withAgentInstall(harness, ['external_action.execute', 'knowledge.search']);

    await expect(svc.install('u1', 'e2', { organizationId: 'org1' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('agent.tools 含不可获得的工具：external_action.execute'),
    });
    // 拒绝发生在物化之前：安装行/Agent/AgentVersion 一律未写
    expect(prisma.extensionInstallation.upsert).not.toHaveBeenCalled();
    expect(prisma.agent.create).not.toHaveBeenCalled();
    expect(prisma.agentVersion.create).not.toHaveBeenCalled();
    // 拒绝由唯一实现裁决（同一函数被调用），而不是别处的复制判断
    expect(resolveEffectiveAgentTools).toHaveBeenCalled();
  });

  it('物化期（setEnabled 重放历史清单）：越权工具被剔除、合法工具保留 + logger.warn 审计 + 剔除清单落 AgentVersion.config', async () => {
    const harness = makeHarness();
    const { svc, prisma } = harness;
    // 历史数据：启用时从已锁定版本重新物化（不重解析），清单里含 external_action.execute / billing.charge / 未知工具
    withAgentInstall(harness, ['external_action.execute', 'billing.charge', 'nope.tool', 'knowledge.search', 'image.generate']);
    prisma.extensionInstallation.findUnique.mockResolvedValue({ id: 'i2', organizationId: 'org1', extensionId: 'e2', versionId: 'v1', status: 'disabled' });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await svc.setEnabled('u1', 'e2', 'org1', true);

    const createArg = prisma.agentVersion.create.mock.calls.at(-1)![0] as {
      data: { tools: string[]; config: { extensionId: string; toolPolicy?: { dropped: Array<{ name: string; reason: string }> } } };
    };
    // 交集：read/generate 保留；external_action/financial/未知工具全部剔除
    expect(createArg.data.tools).toEqual(['knowledge.search', 'image.generate']);
    expect(createArg.data.tools).not.toContain('external_action.execute');
    // 剔除清单持久化在既有 JSON 列（AgentVersion.config），不新增列
    expect(createArg.data.config.toolPolicy?.dropped).toEqual([
      { name: 'external_action.execute', reason: 'tool_permission_not_wrappable' },
      { name: 'billing.charge', reason: 'tool_permission_not_wrappable' },
      { name: 'nope.tool', reason: 'platform_tool_not_registered' },
    ]);
    // 审计日志：含扩展标识 / 工具名 / 原因
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('e2') && m.includes('external_action.execute') && m.includes('tool_permission_not_wrappable'))).toBe(true);
    expect(messages.some((m) => m.includes('billing.charge') && m.includes('financial'))).toBe(true);
    warn.mockRestore();
  });

  it('物化期修复：已存版本行含越权工具（历史/被篡改）→ 重新物化生成修复版本，绝不沿用越权清单', async () => {
    const harness = makeHarness();
    const { svc, prisma } = harness;
    withAgentInstall(harness, ['knowledge.search']);
    prisma.extensionInstallation.findUnique.mockResolvedValue({ id: 'i2', organizationId: 'org1', extensionId: 'e2', versionId: 'v1', status: 'disabled' });
    // 已发布版本行的 tools 被写入越权工具（模拟修复前的物化结果）
    prisma.agent.findUnique.mockResolvedValue({
      id: 'a1', slug: 'ext-brand-00000000', activeVersion: {
        id: 'av1', tools: ['external_action.execute', 'knowledge.search'],
        config: { extensionId: 'e2', extensionVersion: 'v1' },
      },
    });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await svc.setEnabled('u1', 'e2', 'org1', true);

    const createArg = prisma.agentVersion.create.mock.calls.at(-1)![0] as { data: { tools: string[]; version: number } };
    expect(createArg.data.tools).toEqual(['knowledge.search']); // 修复：越权工具被剔除
    expect(createArg.data.version).toBe(1);                     // 与既有 activeVersion 无关，生成新版本行（aggregate 默认 _max=0 → 1）
    expect(prisma.agentVersion.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'archived' } }));
    warn.mockRestore();
  });

  it('物化期幂等：同一锁定版本 + 已存工具集与求交结果一致 → 不新建版本行（无谓漂移）', async () => {
    const harness = makeHarness();
    const { svc, prisma } = harness;
    withAgentInstall(harness, ['knowledge.search']);
    prisma.extensionInstallation.findUnique.mockResolvedValue({ id: 'i2', organizationId: 'org1', extensionId: 'e2', versionId: 'v1', status: 'disabled' });
    prisma.agent.findUnique.mockResolvedValue({
      id: 'a1', slug: 'ext-brand-00000000', activeVersion: {
        id: 'av1', tools: ['knowledge.search'], config: { extensionId: 'e2', extensionVersion: 'v1' },
      },
    });

    await svc.setEnabled('u1', 'e2', 'org1', true);

    expect(prisma.agentVersion.create).not.toHaveBeenCalled();
    expect(prisma.agent.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { enabled: true } });
  });

  it('三条路径共用唯一实现：install（声明校验 + 物化）与 setEnabled（重放）均调用同一 helper，且输入同源', async () => {
    const harness = makeHarness();
    const { svc, prisma } = harness;
    withAgentInstall(harness, ['knowledge.search', 'external_action.execute'].slice(0, 1));
    const mocked = vi.mocked(resolveEffectiveAgentTools);
    mocked.mockClear();

    await svc.install('u1', 'e2', { organizationId: 'org1' });   // 路径①声明校验 + 路径②物化
    const afterInstall = mocked.mock.calls.length;
    expect(afterInstall).toBe(2); // parse 校验一次 + materializeAgent 一次

    prisma.extensionInstallation.findUnique.mockResolvedValue({ id: 'i2', organizationId: 'org1', extensionId: 'e2', versionId: 'v1', status: 'disabled' });
    await svc.setEnabled('u1', 'e2', 'org1', true);               // 路径③重放已存清单
    expect(mocked.mock.calls.length).toBe(afterInstall + 1);

    // 同一实现、同一 extensionId、同一请求清单（三条路径的输入同源）
    expect(new Set(mocked.mock.calls.map((c) => c[0].extensionId))).toEqual(new Set(['e2']));
    expect(mocked.mock.calls.every((c) => JSON.stringify(c[0].requested) === JSON.stringify(['knowledge.search']))).toBe(true);
    expect(mocked.mock.calls.every((c) => JSON.stringify(c[0].declaredPermissions) === JSON.stringify(['agent.run']))).toBe(true);
  });

  it('交集语义：清单声明更多 permissions 不扩大工具集（工具面由平台注册表 + 可包装权限面决定）', async () => {
    const harness = makeHarness();
    const { svc, prisma } = harness;
    const version = publishedVersion(
      { ...agentManifestWith('brand', ['knowledge.search']), permissions: ['agent.run', 'config.read', 'config.write'] },
      'brand',
    );
    const ext = { id: 'e2', organizationId: 'org1', slug: 'brand', name: '品牌助手', description: 'd', kind: 'agent', status: 'published' };
    prisma.extension.findUnique.mockResolvedValue(ext);
    prisma.extensionVersion.findFirst.mockResolvedValue(version);
    prisma.extensionInstallation.upsert.mockResolvedValue({ id: 'i2', organizationId: 'org1', extensionId: 'e2', versionId: 'v1', status: 'enabled' });
    prisma.agent.findUnique.mockResolvedValue(null);
    const mocked = vi.mocked(resolveEffectiveAgentTools);
    mocked.mockClear();

    await svc.install('u1', 'e2', { organizationId: 'org1' });

    const createArg = prisma.agentVersion.create.mock.calls.at(-1)![0] as { data: { tools: string[] } };
    expect(createArg.data.tools).toEqual(['knowledge.search']); // 多声明 config.* 不带来任何工具
    // 声明权限是"上限面"，不是"扩张源"：三个权限一并进入求交，结果仍只有注册表内 read 面工具
    expect(mocked.mock.calls.every((c) => JSON.stringify(c[0].declaredPermissions) === JSON.stringify(['agent.run', 'config.read', 'config.write']))).toBe(true);
    // 财务/外部副作用面与权限声明无关：清单里没有也拿不到（helper 层面已断言 billing.charge 属不可获得面）
    expect(harness.registry.get('billing.charge')).toBeTruthy();
    expect(resolveEffectiveAgentTools({
      extensionId: 'e2', requested: ['billing.charge'], declaredPermissions: ['agent.run', 'config.read', 'config.write'], lookup: (n) => harness.registry.get(n),
    }).tools).toEqual([]);
  });
});

describe('M10-P14（D16）Extension 组织白名单（ExtensionOrgAllowlist 落点）', () => {
  beforeEach(() => vi.clearAllMocks());

  /** 平台级 agent 类扩展安装视图（organizationId=null：所有组织可见可装；白名单是唯一的组织级门禁） */
  function withPlatformAgentInstall(harness: ReturnType<typeof makeHarness>, tools = ['knowledge.search']) {
    const { prisma } = harness;
    const version = publishedVersion(agentManifestWith('brand', tools), 'brand');
    const ext = { id: 'e2', organizationId: null, slug: 'brand', name: '品牌助手', description: 'd', kind: 'agent', status: 'published' };
    prisma.extension.findUnique.mockResolvedValue(ext);
    prisma.extensionVersion.findFirst.mockResolvedValue(version);
    prisma.extensionVersion.findUnique.mockResolvedValue(version);
    prisma.extensionInstallation.upsert.mockResolvedValue({ id: 'i2', organizationId: 'org1', extensionId: 'e2', versionId: 'v1', status: 'enabled' });
    prisma.agent.findUnique.mockResolvedValue(null);
    return { ext, version };
  }

  it('未配置白名单 = 对所有组织开放：install 正常且 orgAllowlist 不传（既有语义不变）', async () => {
    const harness = makeHarness();
    const { svc, prisma, authz } = harness;
    withPlatformAgentInstall(harness);
    prisma.extensionOrgAllowlist.findMany.mockResolvedValue([]);
    const mocked = vi.mocked(resolveEffectiveAgentTools);
    mocked.mockClear();

    await svc.install('u1', 'e2', { organizationId: 'org1' });

    expect(prisma.extensionInstallation.upsert).toHaveBeenCalled();
    expect(mocked.mock.calls.every((c) => !('orgAllowlist' in c[0]))).toBe(true);
    expect(authz.authorize).toHaveBeenCalledWith('u1', 'org1', 'agent.write');
  });

  it('白名单仅含 org2 → org1 安装被拒（403，绝不落安装行/物化资源）', async () => {
    const harness = makeHarness();
    const { svc, prisma } = harness;
    withPlatformAgentInstall(harness);
    prisma.extensionOrgAllowlist.findMany.mockResolvedValue([{ organizationId: 'org2' }]);

    await expect(svc.install('u1', 'e2', { organizationId: 'org1' })).rejects.toMatchObject({
      code: 'FORBIDDEN', message: expect.stringContaining('组织白名单'),
    });
    expect(prisma.extensionInstallation.upsert).not.toHaveBeenCalled();
    expect(prisma.agent.create).not.toHaveBeenCalled();
  });

  it('白名单含本组织 → 安装放行；白名单后置收紧 → 启用路径同一门禁（403，安装行状态不被改写）', async () => {
    const harness = makeHarness();
    const { svc, prisma } = harness;
    withPlatformAgentInstall(harness);
    prisma.extensionOrgAllowlist.findMany.mockResolvedValue([{ organizationId: 'org1' }]);
    await expect(svc.install('u1', 'e2', { organizationId: 'org1' })).resolves.toBeTruthy();

    prisma.extensionOrgAllowlist.findMany.mockResolvedValue([{ organizationId: 'org2' }]);
    prisma.extensionInstallation.findUnique.mockResolvedValue({ id: 'i2', organizationId: 'org1', extensionId: 'e2', versionId: 'v1', status: 'disabled' });
    await expect(svc.setEnabled('u1', 'e2', 'org1', true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.extensionInstallation.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'enabled' }),
    }));
  });

  it('物化期兜底（历史安装/直连调用）：非白名单组织经 orgAllowlist=[] 求交 → 零工具 + 剔除审计', async () => {
    const harness = makeHarness();
    const { svc, prisma, authz } = harness;
    const { ext, version } = withPlatformAgentInstall(harness);
    prisma.extensionOrgAllowlist.findMany.mockResolvedValue([{ organizationId: 'org2' }]);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const mocked = vi.mocked(resolveEffectiveAgentTools);
    mocked.mockClear();
    const materializeAgent = (svc as unknown as {
      materializeAgent: (e: unknown, v: string, m: unknown, org: string) => Promise<string>;
    }).materializeAgent.bind(svc);

    await materializeAgent(ext, version.id, version.manifest, 'org1');

    expect(authz.authorize).not.toHaveBeenCalled(); // 兜底路径不依赖调用者身份（历史数据物化）
    const call = mocked.mock.calls.at(-1)![0];
    expect(call.orgAllowlist).toEqual([]); // 组织策略面为空 → 全部剔除（fail-closed）
    const createArg = prisma.agentVersion.create.mock.calls.at(-1)![0] as { data: { tools: string[]; config: { toolPolicy?: { dropped: unknown[] } } } };
    expect(createArg.data.tools).toEqual([]);
    expect(createArg.data.config.toolPolicy?.dropped.length).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('组织白名单'));
    warn.mockRestore();
  });

  it('白名单查询：平台级扩展任何登录用户可读；组织私有扩展仅成员可读（非成员 403）；组织禁用不影响只读治理数据', async () => {
    const { svc, prisma, authz } = makeHarness();
    prisma.extension.findUnique.mockResolvedValue({ id: 'e2', organizationId: null, slug: 'brand', kind: 'agent', status: 'published' });
    prisma.extensionOrgAllowlist.findMany.mockResolvedValue([{ organizationId: 'org1', createdAt: new Date(0) }]);
    await expect(svc.listAllowlist('stranger', 'e2')).resolves.toMatchObject({ restricted: true });
    expect(authz.membership).not.toHaveBeenCalled();

    authz.membership.mockResolvedValueOnce(null); // 非成员
    prisma.extension.findUnique.mockResolvedValue({ id: 'e3', organizationId: 'org1', slug: 'priv', kind: 'agent', status: 'published' });
    await expect(svc.listAllowlist('stranger', 'e3')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // 组织禁用（orgStatus=disabled）仍可读：白名单是"为何本组织不可用"的自查入口
    authz.membership.mockResolvedValueOnce({ role: 'owner', orgStatus: 'disabled' });
    await expect(svc.listAllowlist('u1', 'e3')).resolves.toMatchObject({ extensionId: 'e3' });
  });

  it('增条目 RBAC：平台级扩展需平台管理员；组织成员（有 agent.write）与外部人一律拒绝；不可自加入', async () => {
    const { svc, prisma, authz } = makeHarness();
    prisma.extension.findUnique.mockResolvedValue({ id: 'e2', organizationId: null, slug: 'brand', kind: 'agent', status: 'published' });
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'user' });
    await expect(svc.addAllowlistEntry('u1', 'e2', 'org1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.extensionOrgAllowlist.upsert).not.toHaveBeenCalled();

    // 组织私有扩展：owner 可增；member 虽有 agent.write 但白名单是治理动作 → 拒绝
    authz.membership.mockResolvedValue({ role: 'member', orgStatus: 'active' });
    prisma.extension.findUnique.mockResolvedValue({ id: 'e3', organizationId: 'org1', slug: 'priv', kind: 'agent', status: 'published' });
    await expect(svc.addAllowlistEntry('u1', 'e3', 'org2')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    authz.membership.mockResolvedValue({ role: 'owner', orgStatus: 'active' });
    prisma.organization.findFirst.mockResolvedValue({ id: 'org2' });
    await expect(svc.addAllowlistEntry('u1', 'e3', 'org2')).resolves.toBeTruthy();
    expect(prisma.extensionOrgAllowlist.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { extensionId_organizationId: { extensionId: 'e3', organizationId: 'org2' } },
    }));

    // 目标组织不存在 → 404（不落脏数据）
    prisma.organization.findFirst.mockResolvedValue(null);
    await expect(svc.addAllowlistEntry('u1', 'e3', 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('删条目 IDOR：非 extension owner 只能删本组织条目；跨组织删除一律 403；条目不存在 → 404', async () => {
    const { svc, prisma, authz } = makeHarness();
    prisma.extension.findUnique.mockResolvedValue({ id: 'e3', organizationId: 'org1', slug: 'priv', kind: 'agent', status: 'published' });
    authz.membership.mockResolvedValue({ role: 'member', orgStatus: 'active' }); // 调用者仅是扩展所属组织的 member
    authz.authorize.mockRejectedValueOnce(Object.assign(new Error('权限不足'), { code: 'FORBIDDEN' }));

    await expect(svc.removeAllowlistEntry('u2', 'e3', 'org2')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.extensionOrgAllowlist.deleteMany).not.toHaveBeenCalled();

    // 本组织 owner 自助退出：允许（只收回自身可用性，绝不提权）
    authz.membership.mockResolvedValue({ role: 'owner', orgStatus: 'active' });
    authz.authorize.mockResolvedValue('owner');
    prisma.extensionOrgAllowlist.deleteMany.mockResolvedValue({ count: 1 });
    await expect(svc.removeAllowlistEntry('u1', 'e3', 'org1')).resolves.toMatchObject({ removed: true });

    prisma.extensionOrgAllowlist.deleteMany.mockResolvedValue({ count: 0 });
    await expect(svc.removeAllowlistEntry('u1', 'e3', 'org1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('白名单收紧的即时回收：非白名单组织的既有安装 → disabled + 物化资源失效（绝不遗留可用能力）', async () => {
    const { svc, prisma } = makeHarness();
    const ext = { id: 'e4', organizationId: null, slug: 'tool-ext', kind: 'tool', status: 'published' };
    prisma.extension.findUnique.mockResolvedValue(ext);
    prisma.user.findUnique.mockResolvedValue({ id: 'admin', role: 'admin' });
    prisma.organization.findFirst.mockResolvedValue({ id: 'org1' });
    // 白名单 = [org1]；历史安装分布：org1（保留）+ org2（回收）
    prisma.extensionOrgAllowlist.findMany.mockResolvedValue([{ organizationId: 'org1' }]);
    prisma.extensionOrgAllowlist.upsert.mockResolvedValue({ id: 'al-1', extensionId: 'e4', organizationId: 'org1' });
    prisma.extensionInstallation.findMany.mockResolvedValue([
      { id: 'i1', organizationId: 'org1', extensionId: 'e4', versionId: 'v1', status: 'enabled' },
      { id: 'i2', organizationId: 'org2', extensionId: 'e4', versionId: 'v1', status: 'enabled' },
    ]);

    const r = await svc.addAllowlistEntry('admin', 'e4', 'org1');

    expect(r.disabledOrganizations).toEqual(['org2']);
    expect(prisma.extensionInstallation.update).toHaveBeenCalledWith({ where: { id: 'i2' }, data: { status: 'disabled' } });
    expect(prisma.extensionInstallation.update).not.toHaveBeenCalledWith({ where: { id: 'i1' }, data: { status: 'disabled' } });
  });
});
