import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';

/**
 * M9-P6 Marketplace 公开层 e2e（真实 PostgreSQL/Redis + 真实 ExtensionsService/RBAC/F4）。
 *
 * 覆盖：
 * ① 上架门禁（未通过 M8-P6 平台校验的扩展绝不上架）+ 目录可见性（published 公开 / 未发布 404 防枚举）
 * ② 状态机非法边（publish/编辑 经真实 API 断言，状态零改动）
 * ③ 驳回 → 修订 → 重新上架（rejected 无直达 published 的边）+ 作者侧撤回闭环
 * ④ 评分（边界/自评防线/一用户一条 upsert/pending 不计入聚合/审核后计入/撤销通过移除）
 * ⑤ RBAC（匿名 401；非成员 403/404 防枚举；member 可管理条目但**不可**审核；viewer 只读）
 * ⑥ install count 计数投影（ExtensionInstallation 既有表计数，多组织安装递增，不新建事实表）
 * ⑦ **评分不提升权限**（F4 语义：1 星与 5 星下扩展授予的工具白名单完全一致；越权工具
 *    external_action 在**声明期**即被平台拒绝——市场/评分不构成任何授权旁路）
 * ⑧ 平台级扩展上架需平台管理员
 * ⑨ 404 防枚举（不存在 id / 跨组织未发布条目 / 不存在评审；响应零字段泄漏）
 *
 * 运行方式（**独立 Redis DB 10**，与 m8-p6（db 0）/m9-p1(5)/m9-p3(7)/m9-p4(8)/m9-p5(9) 隔离）：
 *   cd apps/api && REDIS_URL=redis://localhost:6379/10 npx vitest run test/m9-p6-marketplace.e2e-spec.ts
 */
const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/10';
process.env.MOCK_DELAY_MS = '0';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

describe('M9-P6 Marketplace (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const api = () => request(app.getHttpServer());

  let cookie = ''; // 种子管理员（平台管理员；同时是 orgA owner）
  let userId = '';
  let cookieB = ''; // 局外人（非 orgA 成员）
  let userB = '';
  let cookieC = ''; // orgA member（agent.write 有 / member.write 无）
  let userC = '';
  let cookieV = ''; // orgA viewer（只读）
  let userV = '';
  let orgA = '';
  let orgB = ''; // userB 的个人组织

  const stamp = Date.now().toString(36);
  const createdExtensionIds: string[] = [];
  const createdPublicationIds: string[] = [];
  const createdAgentIds: string[] = [];

  const toolSlug = `p6mkt-tool-${stamp}`;
  const agentSlug = `p6mkt-agent-${stamp}`;
  const platSlug = `p6mkt-plat-${stamp}`;
  const draftSlug = `p6mkt-draft-${stamp}`;
  let toolExtId = '';
  let agentExtId = '';
  let platExtId = '';
  let draftExtId = '';
  let materializedAgentId = '';

  let toolPublicationId = '';
  let platPublicationId = '';
  let agentPublicationId = '';
  let reviewId = ''; // 局外人乙在 toolPublication 上的评审（④ 产生；⑤ 用于审核权矩阵）

  beforeAll(async () => {
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

    const login = await api().post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id as string;

    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);
    const { OrganizationsService } = await import('../src/modules/organizations/organizations.service');
    const orgs = moduleRef.get(OrganizationsService);

    // 局外人 B（非 orgA 成员）：集合级 403 / 资源级 404 矩阵
    const b = await prisma.user.create({ data: { email: `p6mkt-b-${stamp}@example.com`, passwordHash: 'unused-hash', displayName: '局外人乙' } });
    userB = b.id;
    cookieB = `agent_access=${await jwt.signAsync({ sub: userB, role: 'user' })}`;
    orgB = (await orgs.ensurePersonalOrganization(userB)).id;

    // orgA 内 member / viewer
    const c = await prisma.user.create({ data: { email: `p6mkt-c-${stamp}@example.com`, passwordHash: 'unused-hash', displayName: '成员丙' } });
    userC = c.id;
    cookieC = `agent_access=${await jwt.signAsync({ sub: userC, role: 'user' })}`;
    const v = await prisma.user.create({ data: { email: `p6mkt-v-${stamp}@example.com`, passwordHash: 'unused-hash', displayName: '只读丁' } });
    userV = v.id;
    cookieV = `agent_access=${await jwt.signAsync({ sub: userV, role: 'user' })}`;

    const org = await api().post('/api/v1/organizations').set(XRW).set('Cookie', cookie)
      .send({ name: '市场测试组织', slug: `p6mkt-org-${stamp}` }).expect(201);
    orgA = org.body.data.id as string;
    await prisma.organizationMember.create({ data: { organizationId: orgA, userId: userC, role: 'member' } });
    await prisma.organizationMember.create({ data: { organizationId: orgA, userId: userV, role: 'viewer' } });

    // tool 类扩展（orgA 私有）：创建 → 发布（签名）→ 安装（本组织 1 次）
    const toolExt = await api().post('/api/v1/extensions').set(XRW).set('Cookie', cookie)
      .send({
        organizationId: orgA, name: '市场检索扩展', slug: toolSlug, kind: 'tool',
        description: '封装平台知识检索（声明式，无代码）',
        manifest: {
          manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'],
          tool: { name: `ext.${toolSlug}.search`, description: '按约束检索知识库', baseTool: 'knowledge.search' },
        },
      }).expect(201);
    toolExtId = toolExt.body.data.extension.id as string;
    createdExtensionIds.push(toolExtId);
    await api().post(`/api/v1/extensions/${toolExtId}/publish`).set(XRW).set('Cookie', cookie).send({}).expect(201);
    await api().post(`/api/v1/extensions/${toolExtId}/install`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA }).expect(201);

    // agent 类扩展（orgA 私有）：工具清单必须落在 F4 可获得面内（越权项在声明期即 400，见 ⑦）
    const agentExt = await api().post('/api/v1/extensions').set(XRW).set('Cookie', cookie)
      .send({
        organizationId: orgA, name: '市场品牌助手', slug: agentSlug, kind: 'agent',
        description: '扩展品牌助手（声明式，无代码）',
        manifest: {
          manifestVersion: 1, kind: 'agent', permissions: ['agent.run'],
          agent: {
            name: `brand-agent-${stamp}`, description: '扩展品牌助手',
            systemPrompt: '你是 {{extension.name}}（组织 {{organization.id}}），回答简洁。',
            tools: ['knowledge.search', 'image.generate'],
          },
        },
      }).expect(201);
    agentExtId = agentExt.body.data.extension.id as string;
    createdExtensionIds.push(agentExtId);
    await api().post(`/api/v1/extensions/${agentExtId}/publish`).set(XRW).set('Cookie', cookie).send({}).expect(201);
    const agentInstall = await api().post(`/api/v1/extensions/${agentExtId}/install`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA }).expect(201);
    materializedAgentId = agentInstall.body.data.materialized.agentId as string;
    createdAgentIds.push(materializedAgentId);

    // 平台级扩展（organizationId=null；仅平台管理员可建/可上架；安装量跨组织计数用）
    const platExt = await api().post('/api/v1/extensions').set(XRW).set('Cookie', cookie)
      .send({
        organizationId: null, name: '平台检索扩展', slug: platSlug, kind: 'tool',
        description: '平台级只读检索扩展（声明式，无代码）',
        manifest: {
          manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'],
          tool: { name: `ext.${platSlug}.search`, description: '平台级只读检索', baseTool: 'knowledge.search' },
        },
      }).expect(201);
    platExtId = platExt.body.data.extension.id as string;
    createdExtensionIds.push(platExtId);
    await api().post(`/api/v1/extensions/${platExtId}/publish`).set(XRW).set('Cookie', cookie).send({}).expect(201);

    // draft 扩展（未通过平台发布校验 → 上架门禁必须拒绝）
    const draftExt = await api().post('/api/v1/extensions').set(XRW).set('Cookie', cookie)
      .send({
        organizationId: orgA, name: '未发布扩展', slug: draftSlug, kind: 'tool',
        description: '尚未发布的扩展（门禁用例）',
        manifest: {
          manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'],
          tool: { name: `ext.${draftSlug}.search`, description: 'draft', baseTool: 'knowledge.search' },
        },
      }).expect(201);
    draftExtId = draftExt.body.data.extension.id as string;
    createdExtensionIds.push(draftExtId);
  }, 60_000);

  afterAll(async () => {
    if (createdPublicationIds.length) {
      await prisma.extensionPublication.deleteMany({ where: { id: { in: createdPublicationIds } } }).catch(() => undefined);
    }
    if (createdAgentIds.length) {
      await prisma.agentVersion.deleteMany({ where: { agentId: { in: createdAgentIds } } }).catch(() => undefined);
      await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } }).catch(() => undefined);
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
    await prisma.user.deleteMany({ where: { id: { in: [userB, userC, userV] } } }).catch(() => undefined);
    await app.close();
  }, 60_000);

  it('① 上架门禁 + 目录可见性：未发布扩展拒绝上架；published 后进公开目录（发布者/安装量/权限披露）', async () => {
    // 门禁：draft 扩展（未经平台发布）不可上架 → 400
    await api().post('/api/v1/marketplace/publications').set(XRW).set('Cookie', cookie)
      .send({ extensionId: draftExtId, category: 'knowledge', description: '未发布扩展不得上架的描述文本' })
      .expect(400);

    // 创建草稿条目（发布者组织由服务端从扩展推导，绝不接受请求体）
    const created = await api().post('/api/v1/marketplace/publications').set(XRW).set('Cookie', cookie)
      .send({
        extensionId: toolExtId, category: 'knowledge', description: '面向组织知识库的只读检索扩展（声明式，无代码）',
        changelog: [{ version: '1.0.0', notes: '首个版本' }],
        compatibility: { minPlatformVersion: '1.0.0', notes: '需要 M8 及以上平台' },
      }).expect(201);
    toolPublicationId = created.body.data.id as string;
    createdPublicationIds.push(toolPublicationId);
    expect(created.body.data.status).toBe('draft');
    expect(created.body.data.organizationId).toBe(orgA);

    // draft 不进公开目录；跨组织详情 → 404 防枚举（响应零字段泄漏）
    const hidden = await api().get(`/api/v1/marketplace/publications?q=${toolSlug}`).set(XRW).set('Cookie', cookieB).expect(200);
    expect(hidden.body.data.items).toHaveLength(0);
    const denied = await api().get(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookieB).expect(404);
    expect(denied.body.error.code).toBe('NOT_FOUND');
    expect(denied.body.data).toBeUndefined();
    expect(JSON.stringify(denied.body)).not.toContain('只读检索扩展');

    // 上架 → published
    const published = await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/publish`).set(XRW).set('Cookie', cookie).expect(201);
    expect(published.body.data.status).toBe('published');

    // 公开目录可见（任何已登录用户可读）
    const found = await api().get(`/api/v1/marketplace/publications?q=${toolSlug}`).set(XRW).set('Cookie', cookieB).expect(200);
    expect(found.body.data.total).toBe(1);
    expect(found.body.data).toMatchObject({ page: 1, limit: 20, totalPages: 1 });
    const item = found.body.data.items[0];
    expect(item).toMatchObject({ id: toolPublicationId, status: 'published', category: 'knowledge' });
    expect(item.publisher).toMatchObject({ organizationId: orgA, organizationName: '市场测试组织' });
    expect(item.extension).toMatchObject({ slug: toolSlug, kind: 'tool', scope: 'organization' });
    expect(item.publishedVersion.version).toBe(1);
    expect(item.publishedVersion.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(item.installCount).toBe(1); // ExtensionInstallation 既有表计数（本组织 1 次安装）
    expect(item.rating).toMatchObject({ average: null, count: 0 }); // 无评分 → null（绝不伪造 0 分）
    expect(item.rating.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
    expect(item.permissionDisclosure).toMatchObject({
      readOnly: true, kind: 'tool', requestedTools: [], effectiveTools: [], droppedTools: [],
      wrappedTool: { baseTool: 'knowledge.search', baseToolPermission: 'read', wrappable: true },
    });
    expect(item.permissionDisclosure.policy).toContain('评分/审核状态/安装量均不参与授权');
    expect(item.permissionDisclosure.declaredPermissions).toHaveLength(1);
    expect(item.permissionDisclosure.declaredPermissions[0]).toMatchObject({ name: 'tool.execute', scope: 'organization' });
    // manifest 本体绝不整体回显（只回显校验证据 + 披露）
    expect(JSON.stringify(item)).not.toContain('按约束检索知识库');

    // 详情（作者视角：可管理 + 可审核）
    const detail = await api().get(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookie).expect(200);
    expect(detail.body.data.viewer).toMatchObject({ role: 'owner', platformAdmin: true, canManage: true, canModerate: true, myReview: null });
    expect(detail.body.data.changelog).toEqual([{ version: '1.0.0', notes: '首个版本' }]);
    expect(detail.body.data.compatibility).toEqual({ minPlatformVersion: '1.0.0', notes: '需要 M8 及以上平台' });
    expect(detail.body.data.reviews).toEqual([]);

    // 分类白名单 + 已上架计数（只读投影）
    const categories = await api().get('/api/v1/marketplace/categories').set(XRW).set('Cookie', cookieB).expect(200);
    expect(categories.body.data.find((c: { category: string }) => c.category === 'knowledge').publishedCount).toBeGreaterThanOrEqual(1);
    expect(categories.body.data.find((c: { category: string }) => c.category === 'finance').publishedCount).toBe(0);

    // 非公开状态检索：必须显式 organizationId + 成员身份（防跨组织枚举）
    await api().get('/api/v1/marketplace/publications?status=draft').set(XRW).set('Cookie', cookie).expect(400);
    await api().get(`/api/v1/marketplace/publications?status=all&organizationId=${orgA}`).set(XRW).set('Cookie', cookieB).expect(403);
    const mine = await api().get(`/api/v1/marketplace/publications?status=all&organizationId=${orgA}`).set(XRW).set('Cookie', cookie).expect(200);
    expect(mine.body.data.total).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('② 状态机非法边（真实 API）：重复上架 / 编辑已上架 → 400 且状态与内容零改动', async () => {
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/publish`).set(XRW).set('Cookie', cookie).expect(400);
    await api().patch(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookie)
      .send({ description: '试图绕过撤回直接改内容' }).expect(400);
    const row = await prisma.extensionPublication.findUnique({ where: { id: toolPublicationId } });
    expect(row?.status).toBe('published');
    expect(row?.description).toBe('面向组织知识库的只读检索扩展（声明式，无代码）');
  }, 60_000);

  it('③ 驳回 → 修订 → 重新上架：rejected 无直达 published 的边；作者侧撤回闭环', async () => {
    // owner 驳回（published → rejected；治理动作）
    const rejected = await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/reject`).set(XRW).set('Cookie', cookie)
      .send({ reason: '分类与内容不符，请调整后重新提交' }).expect(201);
    expect(rejected.body.data.status).toBe('rejected');

    // 驳回后：跨组织详情 404、公开目录不可见
    await api().get(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookieB).expect(404);
    const gone = await api().get(`/api/v1/marketplace/publications?q=${toolSlug}`).set(XRW).set('Cookie', cookieB).expect(200);
    expect(gone.body.data.total).toBe(0);
    // rejected → published 无直达边（必须先 revise）；rejected 上撤回亦无该边
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/publish`).set(XRW).set('Cookie', cookie).expect(400);
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/withdraw`).set(XRW).set('Cookie', cookie).expect(400);

    // 修订（rejected → draft）→ 编辑 → 重新上架（重走门禁）
    const revised = await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/revise`).set(XRW).set('Cookie', cookie).expect(201);
    expect(revised.body.data.status).toBe('draft');
    const edited = await api().patch(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookie)
      .send({ category: 'productivity' }).expect(200);
    expect(edited.body.data.category).toBe('productivity');
    const republished = await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/publish`).set(XRW).set('Cookie', cookie).expect(201);
    expect(republished.body.data.status).toBe('published');

    // 撤回（published → draft）→ 草稿侧的非法边（revise/reject/withdraw 均无出边）→ 再上架
    const withdrawn = await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/withdraw`).set(XRW).set('Cookie', cookie).expect(201);
    expect(withdrawn.body.data.status).toBe('draft');
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/revise`).set(XRW).set('Cookie', cookie).expect(400);
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/reject`).set(XRW).set('Cookie', cookie)
      .send({ reason: '草稿不可被驳回' }).expect(400);
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/withdraw`).set(XRW).set('Cookie', cookie).expect(400);
    // 草稿状态未被非法动作改变
    expect((await prisma.extensionPublication.findUnique({ where: { id: toolPublicationId } }))?.status).toBe('draft');
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/publish`).set(XRW).set('Cookie', cookie).expect(201);
  }, 60_000);

  it('④ 评分：边界拒绝、自评防线、一用户一条（upsert）、pending 不计入、审核后计入、撤销通过移除', async () => {
    // 评分边界（zod + 服务层双保险）
    for (const rating of [0, 6, 2.5]) {
      await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/reviews`).set(XRW).set('Cookie', cookieB)
        .send({ rating }).expect(400);
    }
    // 发布者自评 → 403（自评刷分防线）
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/reviews`).set(XRW).set('Cookie', cookie)
      .send({ rating: 5, body: '自己给自己打满分' }).expect(403);

    // 局外人打分 → 落库即 pending（不计入公开聚合）
    const first = await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/reviews`).set(XRW).set('Cookie', cookieB)
      .send({ rating: 5, body: '检索很快' }).expect(201);
    reviewId = first.body.data.id as string;
    expect(first.body.data.moderationStatus).toBe('pending');

    const pendingDetail = await api().get(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookieB).expect(200);
    expect(pendingDetail.body.data.rating).toMatchObject({ average: null, count: 0 });
    expect(pendingDetail.body.data.reviews).toHaveLength(0);
    expect(pendingDetail.body.data.viewer.myReview).toMatchObject({ id: reviewId, moderationStatus: 'pending' });
    // 非审核者查看待审队列 → 403
    await api().get(`/api/v1/marketplace/publications/${toolPublicationId}/reviews?moderationStatus=pending`).set(XRW).set('Cookie', cookieB).expect(403);

    // 审核通过（owner）→ 计入聚合
    await api().post(`/api/v1/marketplace/reviews/${reviewId}/moderation`).set(XRW).set('Cookie', cookie)
      .send({ status: 'approved' }).expect(201);
    const approved = await api().get(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookieB).expect(200);
    expect(approved.body.data.rating).toMatchObject({ average: 5, count: 1 });
    expect(approved.body.data.rating.distribution[5]).toBe(1);
    expect(approved.body.data.reviews).toHaveLength(1);
    expect(approved.body.data.reviews[0]).toMatchObject({ id: reviewId, rating: 5, reviewer: { userId: userB, displayName: '局外人乙' } });
    expect(JSON.stringify(approved.body.data.reviews)).not.toContain('@example.com'); // 绝不回显邮箱

    // 同用户改分 = upsert（一用户一条，不重复计数）且回到 pending（内容变更须重新审核）
    const second = await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/reviews`).set(XRW).set('Cookie', cookieB)
      .send({ rating: 2, body: '改一下评分' }).expect(201);
    expect(second.body.data.id).toBe(reviewId);
    expect(second.body.data.moderationStatus).toBe('pending');
    expect(await prisma.extensionReview.count({ where: { publicationId: toolPublicationId, userId: userB } })).toBe(1);
    const afterSecond = await api().get(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookieB).expect(200);
    expect(afterSecond.body.data.rating).toMatchObject({ average: null, count: 0 }); // 已通过评审改分不自动生效

    // 再审核通过 → 新分数生效；再撤销通过（approved → rejected）→ 移出聚合
    await api().post(`/api/v1/marketplace/reviews/${reviewId}/moderation`).set(XRW).set('Cookie', cookie)
      .send({ status: 'approved' }).expect(201);
    const rescored = await api().get(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookieB).expect(200);
    expect(rescored.body.data.rating).toMatchObject({ average: 2, count: 1 });
    await api().post(`/api/v1/marketplace/reviews/${reviewId}/moderation`).set(XRW).set('Cookie', cookie)
      .send({ status: 'rejected', reason: '内容与事实不符' }).expect(201);
    const removed = await api().get(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookieB).expect(200);
    expect(removed.body.data.rating).toMatchObject({ average: null, count: 0 });

    // 审核者可见各审核态队列；pending 队列为空（本条目评审已被驳回）
    const queue = await api().get(`/api/v1/marketplace/publications/${toolPublicationId}/reviews?moderationStatus=rejected`)
      .set(XRW).set('Cookie', cookie).expect(200);
    expect(queue.body.data).toHaveLength(1);
    const pendingQueue = await api().get(`/api/v1/marketplace/publications/${toolPublicationId}/reviews?moderationStatus=pending`)
      .set(XRW).set('Cookie', cookie).expect(200);
    expect(pendingQueue.body.data).toHaveLength(0);
    // 恢复通过（rejected → approved）
    await api().post(`/api/v1/marketplace/reviews/${reviewId}/moderation`).set(XRW).set('Cookie', cookie)
      .send({ status: 'approved' }).expect(201);
  }, 60_000);

  it('⑤ RBAC：匿名 401；非成员 403/404 防枚举；member 可管理条目但不可审核；viewer 只读', async () => {
    // 匿名 → 401（读与写一致）
    for (const attempt of [
      api().get('/api/v1/marketplace/publications').set(XRW),
      api().get(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW),
      api().get('/api/v1/marketplace/categories').set(XRW),
      api().post('/api/v1/marketplace/publications').set(XRW).send({ extensionId: toolExtId, category: 'knowledge', description: '匿名创建市场条目' }),
      api().post(`/api/v1/marketplace/publications/${toolPublicationId}/reviews`).set(XRW).send({ rating: 5 }),
      api().post(`/api/v1/marketplace/reviews/${NIL_UUID}/moderation`).set(XRW).send({ status: 'approved' }),
    ]) {
      expect((await attempt).status).toBe(401);
    }

    // 非成员：集合级写 → 403（orgA 私有扩展需该组织 agent.write）；资源级写/治理 → 404 防枚举
    await api().post('/api/v1/marketplace/publications').set(XRW).set('Cookie', cookieB)
      .send({ extensionId: toolExtId, category: 'knowledge', description: '局外人不得发布该扩展条目' }).expect(403);
    for (const path of ['publish', 'withdraw', 'revise']) {
      await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/${path}`).set(XRW).set('Cookie', cookieB).expect(404);
    }
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/reject`).set(XRW).set('Cookie', cookieB)
      .send({ reason: '局外人越权驳回条目' }).expect(404);
    // 审核路由：评审存在性先于 RBAC（不泄露存在性）——非成员对**真实**评审 id 同样 404
    await api().post(`/api/v1/marketplace/reviews/${reviewId}/moderation`).set(XRW).set('Cookie', cookieB)
      .send({ status: 'rejected', reason: '局外人越权审核' }).expect(404);

    // member：agent.write 有（可读 / 可管理条目）→ withdraw + publish 成功；member.write 无 → 审核 403
    await api().get(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookieC).expect(200);
    const withdrawn = await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/withdraw`).set(XRW).set('Cookie', cookieC).expect(201);
    expect(withdrawn.body.data.status).toBe('draft');
    const republished = await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/publish`).set(XRW).set('Cookie', cookieC).expect(201);
    expect(republished.body.data.status).toBe('published');
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/reject`).set(XRW).set('Cookie', cookieC)
      .send({ reason: '成员越权驳回条目' }).expect(403);
    await api().post(`/api/v1/marketplace/reviews/${reviewId}/moderation`).set(XRW).set('Cookie', cookieC)
      .send({ status: 'rejected', reason: '成员越权审核' }).expect(403);
    await api().get(`/api/v1/marketplace/publications/${toolPublicationId}/reviews?moderationStatus=pending`)
      .set(XRW).set('Cookie', cookieC).expect(403);

    // viewer：只读（无 agent.write / member.write）
    await api().get('/api/v1/marketplace/publications').set(XRW).set('Cookie', cookieV).expect(200);
    await api().get(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookieV).expect(200);
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/withdraw`).set(XRW).set('Cookie', cookieV).expect(403);
    await api().post('/api/v1/marketplace/publications').set(XRW).set('Cookie', cookieV)
      .send({ extensionId: toolExtId, category: 'knowledge', description: '只读成员不得发布该扩展' }).expect(403);
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/reject`).set(XRW).set('Cookie', cookieV)
      .send({ reason: '只读成员越权驳回' }).expect(403);
    await api().post(`/api/v1/marketplace/reviews/${reviewId}/moderation`).set(XRW).set('Cookie', cookieV)
      .send({ status: 'rejected', reason: '只读成员越权审核' }).expect(403);
    await api().get(`/api/v1/marketplace/publications/${toolPublicationId}/reviews?moderationStatus=pending`)
      .set(XRW).set('Cookie', cookieV).expect(403);

    // 状态未被任何越权请求改变（条目与评审审核态）
    const row = await prisma.extensionPublication.findUnique({ where: { id: toolPublicationId } });
    expect(row?.status).toBe('published');
    const review = await prisma.extensionReview.findFirst({ where: { publicationId: toolPublicationId } });
    expect(review?.moderationStatus).toBe('approved');
  }, 60_000);

  it('⑥ install count 计数投影：平台级扩展多组织安装递增（既有表计数，不新建事实表）', async () => {
    // 平台级扩展上架（平台管理员；发布者组织 = 其个人组织，绝非 orgA）
    const created = await api().post('/api/v1/marketplace/publications').set(XRW).set('Cookie', cookie)
      .send({ extensionId: platExtId, category: 'developer-tools', description: '平台级只读检索扩展（跨组织可安装）' }).expect(201);
    platPublicationId = created.body.data.id as string;
    createdPublicationIds.push(platPublicationId);
    expect(created.body.data.organizationId).not.toBe(orgA);
    await api().post(`/api/v1/marketplace/publications/${platPublicationId}/publish`).set(XRW).set('Cookie', cookie).expect(201);

    const before = await api().get(`/api/v1/marketplace/publications?q=${platSlug}`).set(XRW).set('Cookie', cookieB).expect(200);
    expect(before.body.data.items[0].installCount).toBe(0);
    expect(before.body.data.items[0].extension.scope).toBe('platform');

    // orgA 安装 → 1；局外人（其个人组织）安装 → 2
    await api().post(`/api/v1/extensions/${platExtId}/install`).set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgA }).expect(201);
    await api().post(`/api/v1/extensions/${platExtId}/install`).set(XRW).set('Cookie', cookieB)
      .send({ organizationId: orgB }).expect(201);

    const after = await api().get(`/api/v1/marketplace/publications?q=${platSlug}`).set(XRW).set('Cookie', cookieB).expect(200);
    expect(after.body.data.items[0].installCount).toBe(2);
    // 计数 = 既有表行数（投影，无第二套事实表）
    expect(await prisma.extensionInstallation.count({ where: { extensionId: platExtId } })).toBe(2);
  }, 60_000);

  it('⑦ 评分不提升权限（F4）：1 星与 5 星下扩展授予的工具白名单完全一致', async () => {
    // 上架 agent 类扩展条目
    const created = await api().post('/api/v1/marketplace/publications').set(XRW).set('Cookie', cookie)
      .send({ extensionId: agentExtId, category: 'automation', description: '组织品牌助手扩展（声明式，无代码）' }).expect(201);
    agentPublicationId = created.body.data.id as string;
    createdPublicationIds.push(agentPublicationId);
    await api().post(`/api/v1/marketplace/publications/${agentPublicationId}/publish`).set(XRW).set('Cookie', cookie).expect(201);
    const visible = await api().get(`/api/v1/marketplace/publications?q=${agentSlug}`).set(XRW).set('Cookie', cookieB).expect(200);
    expect(visible.body.data.items[0].extension.slug).toBe(agentSlug);

    // 声明期 fail-closed：越权工具（external_action → 不可包装面）连扩展都建不出来 ——
    // 授权只发生在 M8-P6 声明/物化期，"市场 + 评分"不构成任何旁路
    await api().post('/api/v1/extensions').set(XRW).set('Cookie', cookie)
      .send({
        organizationId: orgA, name: '越权工具助手', slug: `p6mkt-evil-${stamp}`, kind: 'agent',
        manifest: {
          manifestVersion: 1, kind: 'agent', permissions: ['agent.run'],
          agent: {
            name: `evil-agent-${stamp}`, description: '试图带 external_action',
            systemPrompt: 'x', tools: ['knowledge.search', 'external_action.execute'],
          },
        },
      }).expect(400);
    expect(await prisma.extension.findUnique({ where: { slug: `p6mkt-evil-${stamp}` } })).toBeNull(); // 零写入

    // 基线：安装后物化的 Agent 工具面 = F4 交集（与扩展声明一致，无剔除项）
    const baseline = await prisma.agent.findUnique({ where: { id: materializedAgentId }, include: { activeVersion: true } });
    expect(baseline?.activeVersion?.tools).toEqual(['knowledge.search', 'image.generate']);
    const versionBefore = await prisma.extensionVersion.findFirst({ where: { extensionId: agentExtId, status: 'published' } });
    const disclosureBefore = (await api().get(`/api/v1/marketplace/publications/${agentPublicationId}`).set(XRW).set('Cookie', cookieB).expect(200))
      .body.data.permissionDisclosure;
    expect(disclosureBefore.requestedTools).toEqual(['knowledge.search', 'image.generate']);
    expect(disclosureBefore.effectiveTools).toEqual(['knowledge.search', 'image.generate']);
    expect(disclosureBefore.effectiveTools).toEqual(baseline?.activeVersion?.tools); // 披露与物化同源同口径
    expect(disclosureBefore.droppedTools).toEqual([]);

    // 5 星（member 丙）与 1 星（局外人乙）均审核通过 → 聚合 3.0
    const five = await api().post(`/api/v1/marketplace/publications/${agentPublicationId}/reviews`).set(XRW).set('Cookie', cookieC)
      .send({ rating: 5, body: '非常好用' }).expect(201);
    await api().post(`/api/v1/marketplace/reviews/${five.body.data.id}/moderation`).set(XRW).set('Cookie', cookie)
      .send({ status: 'approved' }).expect(201);
    const one = await api().post(`/api/v1/marketplace/publications/${agentPublicationId}/reviews`).set(XRW).set('Cookie', cookieB)
      .send({ rating: 1, body: '不太好用' }).expect(201);
    await api().post(`/api/v1/marketplace/reviews/${one.body.data.id}/moderation`).set(XRW).set('Cookie', cookie)
      .send({ status: 'approved' }).expect(201);

    const detail = await api().get(`/api/v1/marketplace/publications/${agentPublicationId}`).set(XRW).set('Cookie', cookieB).expect(200);
    expect(detail.body.data.rating).toMatchObject({ average: 3, count: 2 });

    // 权限面三次取样完全一致：物化 Agent 工具 / 扩展版本 manifest / Marketplace 披露
    const after = await prisma.agent.findUnique({ where: { id: materializedAgentId }, include: { activeVersion: true } });
    const versionAfter = await prisma.extensionVersion.findFirst({ where: { extensionId: agentExtId, status: 'published' } });
    const disclosureAfter = detail.body.data.permissionDisclosure;
    expect(after?.activeVersion?.tools).toEqual(['knowledge.search', 'image.generate']);
    expect(after?.activeVersion?.tools).toEqual(disclosureAfter.effectiveTools);
    expect(disclosureAfter.effectiveTools).toEqual(disclosureBefore.effectiveTools);
    expect(disclosureAfter.droppedTools).toEqual(disclosureBefore.droppedTools);
    expect(versionAfter?.checksum).toBe(versionBefore?.checksum); // 评分绝不改写 manifest
    expect(versionAfter?.signature).toBe(versionBefore?.signature);
    expect(versionAfter?.manifest).toEqual(versionBefore?.manifest);
    // 任何评分都不带来 external_action（平台注册表中确实存在该工具——被剔除只因权限面）
    expect(disclosureAfter.effectiveTools).not.toContain('external_action.execute');
    expect(after?.activeVersion?.tools ?? []).not.toContain('external_action.execute');
  }, 60_000);

  it('⑧ 平台级扩展上架需平台管理员：非管理员对平台级扩展建条目 → 403', async () => {
    await api().post('/api/v1/marketplace/publications').set(XRW).set('Cookie', cookieB)
      .send({ extensionId: platExtId, category: 'developer-tools', description: '非管理员不得上架平台级扩展' }).expect(403);
    // 组织私有扩展的越权建条目同样是 403（集合级）
    await api().post('/api/v1/marketplace/publications').set(XRW).set('Cookie', cookieB)
      .send({ extensionId: agentExtId, category: 'automation', description: '非成员不得上架私有扩展条目' }).expect(403);
  }, 60_000);

  it('⑨ 404 防枚举：不存在 id / 跨组织未发布条目 / 不存在评审，响应零字段泄漏', async () => {
    // 不存在的条目（合法 UUID 形状 → 命中 404 而非 500）
    const missing = await api().get(`/api/v1/marketplace/publications/${NIL_UUID}`).set(XRW).set('Cookie', cookie).expect(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect(missing.body.data).toBeUndefined();
    // 不存在的评审：已授权的 owner 也拿 404（存在性不泄露）
    await api().post(`/api/v1/marketplace/reviews/${NIL_UUID}/moderation`).set(XRW).set('Cookie', cookie)
      .send({ status: 'approved' }).expect(404);
    await api().post(`/api/v1/marketplace/publications/${NIL_UUID}/reviews`).set(XRW).set('Cookie', cookieB)
      .send({ rating: 5 }).expect(404);

    // 跨组织未发布条目：撤回后局外人对详情/评审一律 404，且响应体零字段泄漏
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/withdraw`).set(XRW).set('Cookie', cookie).expect(201);
    const hiddenDetail = await api().get(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookieB).expect(404);
    expect(hiddenDetail.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(hiddenDetail.body)).not.toContain('只读检索扩展');
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/reviews`).set(XRW).set('Cookie', cookieB)
      .send({ rating: 5 }).expect(404);
    await api().get(`/api/v1/marketplace/publications/${toolPublicationId}/reviews`).set(XRW).set('Cookie', cookieB).expect(404);
    // 公开目录亦不可见
    const gone = await api().get(`/api/v1/marketplace/publications?q=${toolSlug}`).set(XRW).set('Cookie', cookieB).expect(200);
    expect(gone.body.data.total).toBe(0);
    // 作者本人可见（未发布态回草稿）
    const ownerView = await api().get(`/api/v1/marketplace/publications/${toolPublicationId}`).set(XRW).set('Cookie', cookie).expect(200);
    expect(ownerView.body.data.status).toBe('draft');
    // 恢复上架（收敛到 published）
    await api().post(`/api/v1/marketplace/publications/${toolPublicationId}/publish`).set(XRW).set('Cookie', cookie).expect(201);
  }, 60_000);
});
