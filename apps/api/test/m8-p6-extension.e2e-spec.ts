import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { ToolRegistry } from '../src/core/tools/tool-registry.service';
import { ToolContext } from '../src/core/tools/tool.types';
import { CryptoService } from '../src/core/crypto/crypto.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

async function waitForTerminal(prisma: PrismaService, runId: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (run && ['completed', 'failed', 'cancelled', 'timeout'].includes(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内终态`);
}

/**
 * M8-P6 Extension SDK e2e（真实 PostgreSQL/Redis/Worker + 真实 ToolRegistry）：
 * 声明式 manifest 严格校验（越权/密钥/命名空间拒绝）/ 版本状态机 + 签名 / 安装版本锁定 /
 * tool-agent-provider-workflow_step 物化 / Registry 运行期注册与禁用卸载回收 / 组织 RBAC / 绝不执行任意代码。
 */
describe('M8-P6 Extension SDK (e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let registry: ToolRegistry;
  let cookie: string;
  let cookieB: string;
  let userId = '';
  let userB = '';
  let orgA = '';
  const stamp = Date.now().toString(36);
  const createdExtensionIds: string[] = [];
  const createdRunIds: string[] = [];
  const createdAgentIds: string[] = [];
  const createdProviderIds: string[] = [];

  const toolSlug = `p6-tool-${stamp}`;
  const toolName = `ext.${toolSlug}.search`;
  let toolExtId = '';
  let toolV1Id = '';
  let toolV2Id = '';

  const agentSlug = `p6-agent-${stamp}`;
  let agentExtId = '';
  let materializedAgentId = '';

  const providerSlug = `p6-prov-${stamp}`;
  let providerExtId = '';

  const stepSlug = `p6-step-${stamp}`;
  let stepExtId = '';

  beforeAll(async () => {
    process.env.MOCK_DELAY_MS = '0';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
    await app.listen(0);
    prisma = moduleRef.get(PrismaService);
    registry = moduleRef.get(ToolRegistry);

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id as string;

    // 非成员用户 B（越权矩阵）：prisma 建行 + 应用内 JwtService 签 token
    const b = await prisma.user.create({ data: { email: `p6b-${stamp}@example.com`, passwordHash: 'unused-hash' } });
    userB = b.id;
    const { JwtService } = await import('@nestjs/jwt');
    cookieB = `agent_access=${await moduleRef.get(JwtService).signAsync({ sub: userB, role: 'user' })}`;
    const { OrganizationsService } = await import('../src/modules/organizations/organizations.service');
    await moduleRef.get(OrganizationsService).ensurePersonalOrganization(userB);

    const org = await request(app.getHttpServer()).post('/api/v1/organizations').set(XRW).set('Cookie', cookie)
      .send({ name: '扩展测试组织', slug: `p6org-${stamp}` }).expect(201);
    orgA = org.body.data.id as string;

    // 真实 Worker 上下文（同进程消费 agent-run 队列，验证扩展 Agent 可真实跑完）
    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  });

  afterAll(async () => {
    if (createdRunIds.length) {
      await prisma.generationTask.deleteMany({ where: { runId: { in: createdRunIds } } }).catch(() => undefined);
      await prisma.artifact.deleteMany({ where: { runId: { in: createdRunIds } } }).catch(() => undefined);
      await prisma.usageRecord.deleteMany({ where: { runId: { in: createdRunIds } } }).catch(() => undefined);
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: createdRunIds } } }).catch(() => undefined);
      await prisma.agentRun.deleteMany({ where: { id: { in: createdRunIds } } }).catch(() => undefined);
    }
    if (createdAgentIds.length) {
      await prisma.agentVersion.deleteMany({ where: { agentId: { in: createdAgentIds } } }).catch(() => undefined);
      await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } }).catch(() => undefined);
    }
    if (createdProviderIds.length) {
      await prisma.model.deleteMany({ where: { providerId: { in: createdProviderIds } } }).catch(() => undefined);
      await prisma.provider.deleteMany({ where: { id: { in: createdProviderIds } } }).catch(() => undefined);
    }
    if (createdExtensionIds.length) {
      await prisma.extensionInstallation.deleteMany({ where: { extensionId: { in: createdExtensionIds } } }).catch(() => undefined);
      await prisma.extensionVersion.deleteMany({ where: { extensionId: { in: createdExtensionIds } } }).catch(() => undefined);
      await prisma.extension.deleteMany({ where: { id: { in: createdExtensionIds } } }).catch(() => undefined);
    }
    if (orgA) {
      await prisma.organizationInvitation.deleteMany({ where: { organizationId: orgA } }).catch(() => undefined);
      await prisma.organizationMember.deleteMany({ where: { organizationId: orgA } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id: orgA } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: userB } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  it('P6 ① tool 类：创建（严格校验）→ 发布（签名）→ 安装 → ToolRegistry 注册 + 约束拒绝 + 原样透传', async () => {
    // manifest 携带密钥 → 400（凭证只能来自安装 config）
    await request(app.getHttpServer()).post('/api/v1/extensions').set(XRW).set('Cookie', cookie)
      .send({
        organizationId: orgA, name: '带密钥扩展', slug: `p6-bad-${stamp}`, kind: 'tool',
        manifest: {
          manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'],
          tool: { name: `ext.p6-bad-${stamp}.x`, description: 'x', baseTool: 'knowledge.search', apiKey: 'sk-should-be-rejected' },
        },
      })
      .expect(400);

    // 越权权限声明 → 400
    await request(app.getHttpServer()).post('/api/v1/extensions').set(XRW).set('Cookie', cookie)
      .send({
        organizationId: orgA, name: '越权扩展', slug: `p6-bad2-${stamp}`, kind: 'tool',
        manifest: {
          manifestVersion: 1, kind: 'tool', permissions: ['provider.call'],
          tool: { name: `ext.p6-bad2-${stamp}.x`, description: 'x', baseTool: 'knowledge.search' },
        },
      })
      .expect(400);

    const created = await request(app.getHttpServer()).post('/api/v1/extensions').set(XRW).set('Cookie', cookie)
      .send({
        organizationId: orgA, name: '知识检索扩展', slug: toolSlug, kind: 'tool',
        description: '封装平台知识检索（声明式，无代码）',
        manifest: {
          manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'],
          tool: {
            name: toolName, description: '按约束检索知识库', baseTool: 'knowledge.search',
            paramConstraints: { topK: { min: 1, max: 5 }, query: { required: true } },
          },
        },
      })
      .expect(201);
    toolExtId = created.body.data.extension.id as string;
    toolV1Id = created.body.data.version.id as string;
    createdExtensionIds.push(toolExtId);
    expect(created.body.data.extension.status).toBe('draft');
    expect(created.body.data.version.permissions.map((p: { name: string }) => p.name)).toEqual(['tool.execute']);

    // ⑥ 未发布版本不可安装 → 400
    await request(app.getHttpServer()).post(`/api/v1/extensions/${toolExtId}/install`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA, versionId: toolV1Id }).expect(400);

    const published = await request(app.getHttpServer()).post(`/api/v1/extensions/${toolExtId}/publish`).set(XRW).set('Cookie', cookie)
      .send({}).expect(201);
    expect(published.body.data.status).toBe('published');
    expect(published.body.data.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(published.body.data.checksum).toMatch(/^[0-9a-f]{64}$/);

    const installed = await request(app.getHttpServer()).post(`/api/v1/extensions/${toolExtId}/install`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA, versionId: toolV1Id, config: { label: 'e2e' } }).expect(201);
    expect(installed.body.data.installation.versionId).toBe(toolV1Id);
    expect(installed.body.data.materialized.toolName).toBe(toolName);
    // 安装 config 绝不落库密钥字段
    expect(installed.body.data.installation.config).toEqual({ label: 'e2e' });

    // 运行期注册（不修改 ToolsModule/内置工具）
    const tool = registry.get(toolName);
    expect(tool).toBeTruthy();
    expect(tool!.permission).toBe('read'); // 绝不提升权限

    const ctx: ToolContext = {
      userId, projectId: undefined, conversationId: undefined, messageId: undefined,
      agentRunId: 'run-e2e', agentRunStepId: 'step-e2e', toolCallId: 'call-e2e',
      idempotencyKey: `ext-${stamp}`, signal: new AbortController().signal,
    };
    // 约束拒绝（不触达 baseTool）
    await expect(tool!.execute({ query: '品牌', topK: 99 }, ctx)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(tool!.execute({ topK: 3 }, ctx)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // 合法输入原样透传（baseTool 真实执行：mock embedding → 空库 0 结果）
    const out = await tool!.execute({ query: '品牌规范', topK: 3 }, ctx) as { count: number; results: unknown[] };
    expect(out.count).toBe(0);
    expect(Array.isArray(out.results)).toBe(true);
  });

  it('P6 版本状态机 + 安装版本锁定：发布 v2 后已安装实例仍锁定 v1；显式 install 才升级；状态机绝不逆向', async () => {
    const updated = await request(app.getHttpServer()).patch(`/api/v1/extensions/${toolExtId}`).set(XRW).set('Cookie', cookie)
      .send({
        manifest: {
          manifestVersion: 1, kind: 'tool', permissions: ['tool.execute', 'config.read'],
          tool: {
            name: toolName, description: 'v2：更严格约束', baseTool: 'knowledge.search',
            paramConstraints: { topK: { min: 1, max: 3 } },
          },
        },
      })
      .expect(200);
    toolV2Id = updated.body.data.version.id as string;
    expect(updated.body.data.version.version).toBe(2);
    expect(updated.body.data.version.status).toBe('draft');

    // 旧版本（published）不可再被修改：publish 只接受 draft
    await request(app.getHttpServer()).post(`/api/v1/extensions/${toolExtId}/publish`).set(XRW).set('Cookie', cookie)
      .send({ versionId: toolV1Id }).expect(400);

    await request(app.getHttpServer()).post(`/api/v1/extensions/${toolExtId}/publish`).set(XRW).set('Cookie', cookie)
      .send({ versionId: toolV2Id }).expect(201);

    // 版本锁定：installation 仍指向 v1（绝不漂移）
    const installs = await request(app.getHttpServer()).get('/api/v1/extensions/installations').set(XRW).set('Cookie', cookie)
      .query({ organizationId: orgA }).expect(200);
    const mine = (installs.body.data as Array<{ extensionId: string; versionId: string; pinnedVersion: { version: number } }>)
      .find((i) => i.extensionId === toolExtId);
    expect(mine?.versionId).toBe(toolV1Id);
    expect(mine?.pinnedVersion.version).toBe(1);
    expect(registry.get(toolName)).toBeTruthy(); // v1 仍生效

    // 显式升级：install 指定 v2 → 锁定切换 + 约束随新版本生效
    const upgraded = await request(app.getHttpServer()).post(`/api/v1/extensions/${toolExtId}/install`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA, versionId: toolV2Id }).expect(201);
    expect(upgraded.body.data.installation.versionId).toBe(toolV2Id);
    const ctx: ToolContext = {
      userId, agentRunId: 'r', agentRunStepId: 's', toolCallId: 't', idempotencyKey: `ext2-${stamp}`,
      signal: new AbortController().signal,
    };
    await expect(registry.get(toolName)!.execute({ query: 'x', topK: 4 }, ctx)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('P6 ② agent 类：物化为组织私有 Agent（scope=organization）→ 扩展 Agent 可真实创建 run 并跑完', async () => {
    const created = await request(app.getHttpServer()).post('/api/v1/extensions').set(XRW).set('Cookie', cookie)
      .send({
        organizationId: orgA, name: '品牌助手扩展', slug: agentSlug, kind: 'agent',
        manifest: {
          manifestVersion: 1, kind: 'agent', permissions: ['agent.run'],
          agent: {
            name: 'brand-agent', description: '扩展品牌助手',
            systemPrompt: '你是 {{extension.name}}（组织 {{organization.id}}），回答简洁。',
            tools: ['knowledge.search'],
          },
        },
      })
      .expect(201);
    agentExtId = created.body.data.extension.id as string;
    createdExtensionIds.push(agentExtId);
    const versionId = created.body.data.version.id as string;
    await request(app.getHttpServer()).post(`/api/v1/extensions/${agentExtId}/publish`).set(XRW).set('Cookie', cookie).send({}).expect(201);
    const install = await request(app.getHttpServer()).post(`/api/v1/extensions/${agentExtId}/install`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA, versionId }).expect(201);
    materializedAgentId = install.body.data.materialized.agentId as string;
    createdAgentIds.push(materializedAgentId);

    const agent = await prisma.agent.findUnique({ where: { id: materializedAgentId }, include: { activeVersion: true } });
    expect(agent?.scope).toBe('organization');
    expect(agent?.organizationId).toBe(orgA);
    expect(agent?.kind).toBe('custom');
    expect(agent?.enabled).toBe(true);
    expect(agent?.activeVersion?.status).toBe('published');
    expect(agent?.activeVersion?.tools).toEqual(['knowledge.search']);
    expect(agent?.activeVersion?.systemPrompt).toContain('品牌助手扩展'); // 模板变量已渲染，未泄露原始占位符处理

    // 扩展 Agent 真实可运行（复用平台 Agent 体系：AgentRun 锁定 AgentVersion）
    const run = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: materializedAgentId, message: '你好，介绍一下你自己' }).expect(201);
    createdRunIds.push(run.body.data.runId as string);
    expect(run.body.data.status).toBe('queued');
    expect(await waitForTerminal(prisma, run.body.data.runId as string)).toBe('completed');
    const runRow = await prisma.agentRun.findUnique({ where: { id: run.body.data.runId as string } });
    expect(runRow?.agentVersionId).toBe(agent?.activeVersionId);

    // 越权：非组织成员用同一 agentId 创建 run → 404（防枚举）
    await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookieB)
      .send({ agentId: materializedAgentId, message: '越权调用' }).expect(404);
  });

  it('P6 ④ provider 类：安装必须由组织提供 apiKey（加密落库）→ Provider/Model 物化 + 启停', async () => {
    const created = await request(app.getHttpServer()).post('/api/v1/extensions').set(XRW).set('Cookie', cookie)
      .send({
        organizationId: orgA, name: '第三方推理扩展', slug: providerSlug, kind: 'provider',
        manifest: {
          manifestVersion: 1, kind: 'provider', permissions: ['provider.call'],
          provider: {
            name: '扩展推理服务', adapter: 'openai-compatible', baseUrl: 'https://api.example.com/v1',
            models: [{ name: 'gpt-x', apiModelId: `gpt-x-${stamp}`, type: 'llm' }],
          },
        },
      })
      .expect(201);
    providerExtId = created.body.data.extension.id as string;
    createdExtensionIds.push(providerExtId);
    await request(app.getHttpServer()).post(`/api/v1/extensions/${providerExtId}/publish`).set(XRW).set('Cookie', cookie).send({}).expect(201);

    // 缺 apiKey → 400（manifest 绝不携带密钥）
    await request(app.getHttpServer()).post(`/api/v1/extensions/${providerExtId}/install`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA }).expect(400);

    const install = await request(app.getHttpServer()).post(`/api/v1/extensions/${providerExtId}/install`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA, config: { apiKey: `sk-e2e-${stamp}-secret`, region: 'cn' } }).expect(201);
    const providerId = install.body.data.materialized.providerId as string;
    createdProviderIds.push(providerId);

    const provider = await prisma.provider.findUnique({ where: { id: providerId }, include: { models: true } });
    expect(provider?.adapter).toBe('openai-compatible');
    expect(provider?.baseUrl).toBe('https://api.example.com/v1');
    expect(provider?.enabled).toBe(true);
    expect(provider?.apiKeyEncrypted).not.toContain('sk-e2e');
    expect(new CryptoService(process.env.ENCRYPTION_KEY ?? '').decrypt(provider!.apiKeyEncrypted)).toBe(`sk-e2e-${stamp}-secret`);
    expect(provider?.models.some((m) => m.apiModelId === `gpt-x-${stamp}` && m.enabled)).toBe(true);
    // 安装行 config 不含密钥
    expect(JSON.stringify(install.body.data.installation.config)).not.toContain('sk-e2e');

    // 停用 → Provider/Model 标记失效；启用 → 恢复
    await request(app.getHttpServer()).post(`/api/v1/extensions/${providerExtId}/disable`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA }).expect(201);
    expect((await prisma.provider.findUnique({ where: { id: providerId } }))?.enabled).toBe(false);
    await request(app.getHttpServer()).post(`/api/v1/extensions/${providerExtId}/enable`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA }).expect(201);
    expect((await prisma.provider.findUnique({ where: { id: providerId } }))?.enabled).toBe(true);
  });

  it('P6 workflow_step 类：安装后暴露可查询步骤模板；archive 后不可再用（状态机单向）', async () => {
    const created = await request(app.getHttpServer()).post('/api/v1/extensions').set(XRW).set('Cookie', cookie)
      .send({
        organizationId: orgA, name: '检索步骤扩展', slug: stepSlug, kind: 'workflow_step',
        manifest: {
          manifestVersion: 1, kind: 'workflow_step', permissions: ['workflow.step'],
          workflow_step: { name: 'search-step', stepType: 'tool', description: '知识检索步骤', params: { toolName: 'knowledge.search' } },
        },
      })
      .expect(201);
    stepExtId = created.body.data.extension.id as string;
    createdExtensionIds.push(stepExtId);
    await request(app.getHttpServer()).post(`/api/v1/extensions/${stepExtId}/publish`).set(XRW).set('Cookie', cookie).send({}).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/extensions/${stepExtId}/install`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA }).expect(201);

    const steps = await request(app.getHttpServer()).get('/api/v1/extensions/steps').set(XRW).set('Cookie', cookie)
      .query({ organizationId: orgA }).expect(200);
    const mine = (steps.body.data as Array<{ extensionSlug: string; name: string; stepType: string; params: Record<string, unknown> }>)
      .find((s) => s.extensionSlug === stepSlug);
    expect(mine).toBeTruthy();
    expect(mine!.name).toBe('search-step');
    expect(mine!.stepType).toBe('tool');
    expect(mine!.params.toolName).toBe('knowledge.search');

    // 归档 = 终态：publish/deprecate 均拒绝（绝不逆向）
    await request(app.getHttpServer()).post(`/api/v1/extensions/${stepExtId}/archive`).set(XRW).set('Cookie', cookie).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/extensions/${stepExtId}/publish`).set(XRW).set('Cookie', cookie).send({}).expect(400);
    await request(app.getHttpServer()).post(`/api/v1/extensions/${stepExtId}/deprecate`).set(XRW).set('Cookie', cookie).expect(400);
    const after = await request(app.getHttpServer()).get('/api/v1/extensions/steps').set(XRW).set('Cookie', cookie)
      .query({ organizationId: orgA }).expect(200);
    expect((after.body.data as Array<{ extensionSlug: string }>).some((s) => s.extensionSlug === stepSlug)).toBe(false);
  });

  it('P6 ③⑤ 禁用/启用与越权：非成员安装 → 403；disable 后注册表移除不可用；catalog 可见性按组织', async () => {
    // ⑤ 非成员（B）安装组织私有扩展 → 403
    await request(app.getHttpServer()).post(`/api/v1/extensions/${toolExtId}/install`).set(XRW).set('Cookie', cookieB)
      .send({ organizationId: orgA }).expect(403);
    // 非成员创建扩展 → 403
    await request(app.getHttpServer()).post('/api/v1/extensions').set(XRW).set('Cookie', cookieB)
      .send({
        organizationId: orgA, name: 'x', slug: `p6-x-${stamp}`, kind: 'tool',
        manifest: { manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'], tool: { name: `ext.p6-x-${stamp}.x`, description: 'x', baseTool: 'knowledge.search' } },
      })
      .expect(403);
    // 匿名 → 401
    await request(app.getHttpServer()).get('/api/v1/extensions/catalog').query({ organizationId: orgA }).expect(401);
    // organizationId 缺失 → 400（多租户边界）
    await request(app.getHttpServer()).get('/api/v1/extensions/catalog').set(XRW).set('Cookie', cookie).expect(400);

    // ③ disable → 注册表移除（工具不可用）
    await request(app.getHttpServer()).post(`/api/v1/extensions/${toolExtId}/disable`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA }).expect(201);
    expect(registry.get(toolName)).toBeUndefined();
    // enable → 重新注册
    await request(app.getHttpServer()).post(`/api/v1/extensions/${toolExtId}/enable`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA }).expect(201);
    expect(registry.get(toolName)).toBeTruthy();

    // catalog：已发布扩展可见（含本组织安装状态）；其它组织（B 的个人组织）看不到 A 的私有扩展
    const personal = await prisma.organization.findFirst({ where: { ownerUserId: userB, isPersonal: true } });
    const catalogB = await request(app.getHttpServer()).get('/api/v1/extensions/catalog').set(XRW).set('Cookie', cookieB)
      .query({ organizationId: personal!.id }).expect(200);
    expect((catalogB.body.data as Array<{ slug: string }>).some((e) => e.slug === toolSlug)).toBe(false);

    const catalog = await request(app.getHttpServer()).get('/api/v1/extensions/catalog').set(XRW).set('Cookie', cookie)
      .query({ organizationId: orgA }).expect(200);
    const item = (catalog.body.data as Array<{ slug: string; installation: { versionId: string } | null }>).find((e) => e.slug === toolSlug);
    expect(item).toBeTruthy();
    expect(item!.installation?.versionId).toBe(toolV2Id);
  });

  it('P6 ④ uninstall：安装行移除 + 物化资源标记失效（不删除历史，保留审计/血缘）', async () => {
    await request(app.getHttpServer()).post(`/api/v1/extensions/${toolExtId}/uninstall`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA }).expect(201);
    expect(registry.get(toolName)).toBeUndefined();

    await request(app.getHttpServer()).post(`/api/v1/extensions/${agentExtId}/uninstall`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA }).expect(201);
    const agent = await prisma.agent.findUnique({ where: { id: materializedAgentId } });
    expect(agent).toBeTruthy();          // 行保留（AgentRun FK/审计）
    expect(agent?.enabled).toBe(false);  // 但不可再用

    await request(app.getHttpServer()).post(`/api/v1/extensions/${providerExtId}/uninstall`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA }).expect(201);
    const providerId = createdProviderIds[0];
    expect((await prisma.provider.findUnique({ where: { id: providerId } }))?.enabled).toBe(false);

    // 卸载后再次卸载 → 404
    await request(app.getHttpServer()).post(`/api/v1/extensions/${toolExtId}/uninstall`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA }).expect(404);
  });
});
