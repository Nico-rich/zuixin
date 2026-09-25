import { Test } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { extensionAgentSlug } from '../src/modules/extensions/extensions.service';
import { parseManifest, signChecksum } from '../src/modules/extensions/manifest';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * Pre-M9 F4 权限提升 e2e：kind=agent 扩展的工具白名单。
 *
 * 威胁：组织成员只要有 agent.write 就能安装/启用自带 tools=['external_action.execute', ...] 的扩展，
 * 从而绕过平台管理员的工具授权控制面（external_action/destructive/financial 类工具本不该由清单自我声明获得）。
 *
 * 断言（真实 PostgreSQL + 真实 ToolRegistry；测试用户为**非平台管理员**的组织 owner）：
 * ① 声明期：清单自声明越权/未知工具 → 400 拒绝（绝不落库、绝不物化）；合法清单正常物化且只含授权面内工具；
 * ② 物化期兜底（历史/篡改数据）：已发布清单含越权工具时，启用路径（不重解析）物化出的 Agent 只含合法工具，
 *    越权工具被剔除 + logger.warn 审计 + 剔除清单落 AgentVersion.config（既有 JSON 列，不新增列）；
 * ③ 启用重放：已激活 AgentVersion 被写入越权工具（历史数据）→ 重新启用生成修复版本，activeVersion 绝不含越权工具。
 */
describe('Pre-M9 F4 Extension agent 工具白名单 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookieM: string;
  let memberId = '';
  let orgM = '';
  const stamp = Date.now().toString(36);
  const createdExtensionIds: string[] = [];
  const createdAgentIds: string[] = [];
  const createdAgentSlugs: string[] = [];
  /** 审计日志捕获（证明剔除被记录：含扩展标识/工具名/原因） */
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const badTool = 'external_action.execute'; // 平台注册表真实工具，permission=external_action（不可由清单自声明获得）
  const superAdminOnlyTool = 'workflow.mutate'; // 注册表中不存在（凭证/工作流变更类工具的代表）

  /** 合法 agent 类扩展清单 */
  const okManifest = (tools: string[]) => ({
    manifestVersion: 1, kind: 'agent', permissions: ['agent.run'],
    agent: { name: 'brand-agent', description: '扩展品牌助手', systemPrompt: '你是 {{extension.name}}。', tools },
  });

  beforeAll(async () => {
    process.env.MOCK_DELAY_MS = '0';
    // 剔除审计走 logger.warn —— e2e 捕获它（不打印，避免噪声）
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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

    // 非平台管理员成员 M（role=user）：prisma 建行 + 应用内 JwtService 签 token（与既有 e2e 同模式）
    const m = await prisma.user.create({ data: { email: `prem9f4-${stamp}@example.com`, passwordHash: 'unused-hash' } });
    memberId = m.id;
    const { JwtService } = await import('@nestjs/jwt');
    cookieM = `agent_access=${await moduleRef.get(JwtService).signAsync({ sub: memberId, role: 'user' })}`;

    // M 创建并拥有组织 → 具备 agent.write（owner），但**不是**平台管理员（role=user）
    const org = await request(app.getHttpServer()).post('/api/v1/organizations').set(XRW).set('Cookie', cookieM)
      .send({ name: 'F4 工具白名单组织', slug: `prem9f4-${stamp}` }).expect(201);
    orgM = org.body.data.id as string;
    const membership = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgM, userId: memberId } },
    });
    expect(membership?.role).toBe('owner');
    expect((await prisma.user.findUnique({ where: { id: memberId } }))?.role).not.toBe('admin');
  });

  afterAll(async () => {
    warnSpy.mockRestore();
    if (createdAgentIds.length) {
      await prisma.agentVersion.deleteMany({ where: { agentId: { in: createdAgentIds } } }).catch(() => undefined);
    }
    for (const slug of createdAgentSlugs) {
      await prisma.agent.deleteMany({ where: { slug } }).catch(() => undefined);
    }
    if (createdExtensionIds.length) {
      await prisma.extensionInstallation.deleteMany({ where: { extensionId: { in: createdExtensionIds } } }).catch(() => undefined);
      await prisma.extensionVersion.deleteMany({ where: { extensionId: { in: createdExtensionIds } } }).catch(() => undefined);
      await prisma.extension.deleteMany({ where: { id: { in: createdExtensionIds } } }).catch(() => undefined);
    }
    if (orgM) {
      await prisma.organizationInvitation.deleteMany({ where: { organizationId: orgM } }).catch(() => undefined);
      await prisma.organizationMember.deleteMany({ where: { organizationId: orgM } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id: orgM } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: memberId } }).catch(() => undefined);
    await app.close();
  });

  it('F4 ① 声明期：成员自声明越权工具 → 400（不落库）；合法清单物化出的 Agent 只含授权面内工具', async () => {
    // external_action.execute：平台注册表存在但权限面为 external_action → 清单自声明一律拒绝
    const bad = await request(app.getHttpServer()).post('/api/v1/extensions').set(XRW).set('Cookie', cookieM)
      .send({
        organizationId: orgM, name: '越权工具扩展', slug: `prem9f4-bad-${stamp}`, kind: 'agent',
        manifest: okManifest([badTool, 'knowledge.search']),
      });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe('VALIDATION_ERROR');
    expect(bad.body.error?.message).toContain(badTool);
    expect(bad.body.error?.message).toContain('agent.tools');
    // 拒绝即不落库（列表里不存在该 slug）
    const listed = await request(app.getHttpServer()).get('/api/v1/extensions').set(XRW).set('Cookie', cookieM)
      .query({ organizationId: orgM }).expect(200);
    expect((listed.body.data as Array<{ slug: string }>).some((e) => e.slug === `prem9f4-bad-${stamp}`)).toBe(false);

    // 未知/未注册工具名（工作流变更类工具的代表）同样拒绝
    const unknown = await request(app.getHttpServer()).post('/api/v1/extensions').set(XRW).set('Cookie', cookieM)
      .send({
        organizationId: orgM, name: '未知工具扩展', slug: `prem9f4-unknown-${stamp}`, kind: 'agent',
        manifest: okManifest([superAdminOnlyTool]),
      });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error?.message).toContain(superAdminOnlyTool);

    // 合法清单：创建 → 发布 → 安装 → 物化（合法工具必须保留）
    const slug = `prem9f4-ok-${stamp}`;
    const created = await request(app.getHttpServer()).post('/api/v1/extensions').set(XRW).set('Cookie', cookieM)
      .send({ organizationId: orgM, name: '品牌助手扩展', slug, kind: 'agent', manifest: okManifest(['knowledge.search']) })
      .expect(201);
    const extId = created.body.data.extension.id as string;
    const versionId = created.body.data.version.id as string;
    createdExtensionIds.push(extId);
    await request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/publish`).set(XRW).set('Cookie', cookieM).send({}).expect(201);
    const installed = await request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/install`).set(XRW).set('Cookie', cookieM)
      .send({ organizationId: orgM, versionId }).expect(201);
    const agentId = installed.body.data.materialized.agentId as string;
    createdAgentIds.push(agentId);
    createdAgentSlugs.push(extensionAgentSlug(slug, orgM));

    const agent = await prisma.agent.findUnique({ where: { id: agentId }, include: { activeVersion: true } });
    expect(agent?.activeVersion?.tools).toEqual(['knowledge.search']);
    expect(agent?.activeVersion?.tools).not.toContain(badTool);
    const verified = await prisma.extensionVersion.findUnique({ where: { id: versionId } });
    expect(verified?.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('F4 ② 物化期兜底：历史已发布清单含越权工具 → 安装被拒，但启用路径物化出的 Agent 只含合法工具（剔除 + 审计 + 持久化）', async () => {
    // 直接建行模拟"修复前/被篡改"的历史扩展（绕过 create 的声明校验；签名与 checksum 自洽）
    const slug = `prem9f4-legacy-${stamp}`;
    const manifest = okManifest([badTool, 'knowledge.search']);
    const ext = await prisma.extension.create({
      data: { organizationId: orgM, ownerUserId: memberId, name: '历史越权扩展', slug, kind: 'agent', status: 'published' },
    });
    createdExtensionIds.push(ext.id);
    createdAgentSlugs.push(extensionAgentSlug(slug, orgM));
    const parsed = parseManifest(manifest, { slug });
    const version = await prisma.extensionVersion.create({
      data: {
        extensionId: ext.id, version: 1, status: 'published', manifest: parsed.manifest as never,
        checksum: parsed.checksum, signature: signChecksum(parsed.checksum, process.env.ENCRYPTION_KEY ?? ''),
      },
    });
    await prisma.extensionInstallation.create({
      data: { organizationId: orgM, extensionId: ext.id, versionId: version.id, status: 'disabled', installedByUserId: memberId },
    });

    // 安装（声明期校验）→ 拒绝：历史越权清单不可安装
    const denied = await request(app.getHttpServer()).post(`/api/v1/extensions/${ext.id}/install`).set(XRW).set('Cookie', cookieM)
      .send({ organizationId: orgM });
    expect(denied.status).toBe(400);
    expect(denied.body.error?.message).toContain(badTool);

    // 启用（setEnabled 以锁定版本重新物化、不重解析）→ 物化期必须自身兜底
    warnSpy.mockClear();
    await request(app.getHttpServer()).post(`/api/v1/extensions/${ext.id}/enable`).set(XRW).set('Cookie', cookieM)
      .send({ organizationId: orgM }).expect(201);

    const agent = await prisma.agent.findUnique({ where: { slug: extensionAgentSlug(slug, orgM) }, include: { activeVersion: true } });
    expect(agent).toBeTruthy();
    createdAgentIds.push(agent!.id);
    // 越权工具绝不写入 Agent.tools；合法工具保留
    expect(agent?.activeVersion?.tools).toEqual(['knowledge.search']);
    expect(agent?.activeVersion?.tools).not.toContain(badTool);
    // 剔除清单落在既有 JSON 列（不新增列）
    const config = (agent?.activeVersion?.config ?? {}) as { extensionId?: string; extensionVersion?: string; toolPolicy?: { dropped: Array<{ name: string; reason: string }> } };
    expect(config.extensionId).toBe(ext.id);
    expect(config.extensionVersion).toBe(version.id);
    expect(config.toolPolicy?.dropped).toEqual([{ name: badTool, reason: 'tool_permission_not_wrappable' }]);
    // 审计日志（logger.warn：扩展标识 + 工具名 + 原因）
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes(ext.id) && m.includes(badTool) && m.includes('tool_permission_not_wrappable'))).toBe(true);

    // 启用重放不是一次性：再次 disable/enable 仍只物化合法工具
    await request(app.getHttpServer()).post(`/api/v1/extensions/${ext.id}/disable`).set(XRW).set('Cookie', cookieM)
      .send({ organizationId: orgM }).expect(201);
    expect((await prisma.agent.findUnique({ where: { id: agent!.id } }))?.enabled).toBe(false);
    await request(app.getHttpServer()).post(`/api/v1/extensions/${ext.id}/enable`).set(XRW).set('Cookie', cookieM)
      .send({ organizationId: orgM }).expect(201);
    const active = await prisma.agentVersion.findUnique({ where: { id: (await prisma.agent.findUnique({ where: { id: agent!.id } }))!.activeVersionId! } });
    expect(active?.tools).toEqual(['knowledge.search']);
  });

  it('F4 ③ 启用重放修复：已激活 AgentVersion 被写入越权工具（历史数据）→ 重新启用生成修复版本', async () => {
    const slug = `prem9f4-repair-${stamp}`;
    const ext = await prisma.extension.create({
      data: { organizationId: orgM, ownerUserId: memberId, name: '修复场景扩展', slug, kind: 'agent', status: 'published' },
    });
    createdExtensionIds.push(ext.id);
    createdAgentSlugs.push(extensionAgentSlug(slug, orgM));
    const parsed = parseManifest(okManifest(['knowledge.search']), { slug });
    const version = await prisma.extensionVersion.create({
      data: {
        extensionId: ext.id, version: 1, status: 'published', manifest: parsed.manifest as never,
        checksum: parsed.checksum, signature: signChecksum(parsed.checksum, process.env.ENCRYPTION_KEY ?? ''),
      },
    });
    const installation = await prisma.extensionInstallation.create({
      data: { organizationId: orgM, extensionId: ext.id, versionId: version.id, status: 'disabled', installedByUserId: memberId },
    });
    // 手工造出"修复前"的物化结果：Agent + 已发布 AgentVersion（tools 里含越权工具）
    const agentSlug = extensionAgentSlug(slug, orgM);
    const agent = await prisma.agent.create({
      data: { slug: agentSlug, name: '修复场景 Agent', kind: 'custom', scope: 'organization', organizationId: orgM, enabled: false },
    });
    createdAgentIds.push(agent.id);
    const badVersion = await prisma.agentVersion.create({
      data: {
        agentId: agent.id, version: 1, status: 'published', systemPrompt: 'p', temperature: 0.7,
        tools: [badTool, 'knowledge.search'],
        config: { extensionId: ext.id, extensionVersion: installation.versionId },
      },
    });
    await prisma.agent.update({ where: { id: agent.id }, data: { activeVersionId: badVersion.id } });

    warnSpy.mockClear();
    await request(app.getHttpServer()).post(`/api/v1/extensions/${ext.id}/enable`).set(XRW).set('Cookie', cookieM)
      .send({ organizationId: orgM }).expect(201);

    const after = await prisma.agent.findUnique({ where: { id: agent.id }, include: { activeVersion: true } });
    expect(after?.activeVersionId).not.toBe(badVersion.id);          // 已切换到修复版本
    expect(after?.activeVersion?.version).toBe(2);                   // 修复 = 新版本行（旧行不可变）
    expect(after?.activeVersion?.tools).toEqual(['knowledge.search']); // 越权工具被剔除
    const archived = await prisma.agentVersion.findUnique({ where: { id: badVersion.id } });
    expect(archived?.status).toBe('archived');                        // 旧行不再生效（不删除：保留血缘）
    // 兜底可重入：再次重放不再新增版本（求交结果与已存一致 → 幂等）
    await request(app.getHttpServer()).post(`/api/v1/extensions/${ext.id}/disable`).set(XRW).set('Cookie', cookieM)
      .send({ organizationId: orgM }).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/extensions/${ext.id}/enable`).set(XRW).set('Cookie', cookieM)
      .send({ organizationId: orgM }).expect(201);
    const versions = await prisma.agentVersion.findMany({ where: { agentId: agent.id } });
    expect(versions).toHaveLength(2);
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.activeVersionId).toBe(after?.activeVersionId);
  });
});
