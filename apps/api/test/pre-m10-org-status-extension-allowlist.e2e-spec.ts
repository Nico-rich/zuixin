import { Test } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { OrganizationsService } from '../src/modules/organizations/organizations.service';
import { extensionAgentSlug } from '../src/modules/extensions/extensions.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * M10-P14（审计 D16 + X-21）e2e：Extension 组织白名单 + 组织禁用态守卫。
 *
 * D16（组织白名单 `ExtensionOrgAllowlist`）：
 * ① 未配置白名单 = 对所有组织开放（既有语义不变，绝不默认收紧）；
 * ② 配置白名单 = 仅白名单组织可安装/启用（非白名单组织 403，且绝不落安装行）；
 * ③ 收紧即时回收：白名单配置后，非白名单组织的既有安装 → disabled + 物化 Agent enabled=false；
 * ④ 管理 RBAC + IDOR：仅 extension owner 可增条目（组织不得自加入提权）；目标组织 owner/admin 可自助退出；
 *    跨组织增删一律 403；成员不可管理；
 * ⑤ 白名单查询 = 只读治理数据（组织禁用也不受影响：它是"为何本组织不可用"的自查入口）。
 *
 * X-21（组织禁用态 `Organization.status=disabled`）：
 * ⑥ 治理端点 RBAC：平台管理员或组织 owner（member/外部组织 403）；个人空间不可被 owner 自助禁用（400）；
 * ⑦ 禁用后该组织成员访问组织端点/组织级扩展端点一律 403 ORG_DISABLED（守卫挂载点 + 服务层纵深）；
 *    禁用是统一冻结（平台管理员的数据面访问同样 403；其豁免仅限治理端点，即"冻结必须可恢复"）；
 * ⑧ 只读治理数据（组织列表、白名单查询）不受影响，保证可自查/可恢复；
 * ⑨ 禁用组织不可再接纳新成员（服务层 acceptInvitation）；owner/平台管理员重新启用后访问恢复。
 *
 * 真实基础设施：PostgreSQL（真实行）+ Redis（`REDIS_URL=redis://localhost:6379/33`，多 worktree 隔离铁律）。
 */
describe('Pre-M10 P14 Extension 组织白名单 + 组织禁用态 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let ownerMId = '';
  let memberMId = '';
  let inviteeId = '';
  let adminCookie = '';
  let ownerMCookie = '';
  let memberMCookie = '';
  let ownerNCookie = '';
  let inviteeCookie = '';
  let orgM = '';
  let orgN = '';
  let personalM = '';
  let extId = '';
  let versionId = '';
  const stamp = Date.now().toString(36);
  const extensionSlug = `prem10p14-ext-${stamp}`;
  const cleanupUserIds: string[] = [];
  const cleanupOrgIds: string[] = [];
  const cleanupExtensionIds: string[] = [];
  let agentSlugs: string[] = [];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const agentManifest = (tools: string[]) => ({
    manifestVersion: 1, kind: 'agent', permissions: ['agent.run'],
    agent: { name: 'p14-allowlist-agent', description: 'P14 组织白名单验证', systemPrompt: '你是 {{extension.name}}。', tools },
  });

  /** 造用户（直连 DB）+ 用应用内 JwtService 签发 cookie（与既有 e2e 同模式） */
  async function makeUser(email: string, role: 'admin' | 'user') {
    const user = await prisma.user.create({ data: { email, passwordHash: 'unused-hash', role } });
    cleanupUserIds.push(user.id);
    return { id: user.id, cookie: `agent_access=${await jwt.signAsync({ sub: user.id, role })}` };
  }

  async function inviteTokenFor(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post(`/api/v1/organizations/${orgM}/invitations`).set(XRW).set('Cookie', ownerMCookie)
      .send({ email }).expect(201);
    return res.body.data.token as string;
  }

  beforeAll(async () => {
    process.env.MOCK_DELAY_MS = '0';
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
    jwt = moduleRef.get(JwtService);

    adminCookie = (await makeUser(`prem10p14-admin-${stamp}@example.com`, 'admin')).cookie;
    const ownerM = await makeUser(`prem10p14-ownerm-${stamp}@example.com`, 'user');
    ownerMId = ownerM.id; ownerMCookie = ownerM.cookie;
    const memberM = await makeUser(`prem10p14-memberm-${stamp}@example.com`, 'user');
    memberMId = memberM.id; memberMCookie = memberM.cookie;
    ownerNCookie = (await makeUser(`prem10p14-ownern-${stamp}@example.com`, 'user')).cookie;
    const invitee = await makeUser(`prem10p14-invitee-${stamp}@example.com`, 'user');
    inviteeId = invitee.id; inviteeCookie = invitee.cookie;

    // 组织 M / N（owner 经 API 创建）；个人空间按 ensurePersonalOrganization 约定建立
    orgM = (await request(app.getHttpServer()).post('/api/v1/organizations').set(XRW).set('Cookie', ownerMCookie)
      .send({ name: 'P14 白名单组织 M', slug: `prem10p14-m-${stamp}` }).expect(201)).body.data.id as string;
    orgN = (await request(app.getHttpServer()).post('/api/v1/organizations').set(XRW).set('Cookie', ownerNCookie)
      .send({ name: 'P14 外部组织 N', slug: `prem10p14-n-${stamp}` }).expect(201)).body.data.id as string;
    cleanupOrgIds.push(orgM, orgN);
    await prisma.organizationMember.create({ data: { organizationId: orgM, userId: memberMId, role: 'member' } });
    personalM = (await app.get(OrganizationsService).ensurePersonalOrganization(ownerMId)).id;
    cleanupOrgIds.push(personalM);

    // 平台级 agent 扩展（平台管理员创建 + 发布）；白名单只约束"谁能用"，不影响扩展自身的可见性
    const created = await request(app.getHttpServer()).post('/api/v1/extensions').set(XRW).set('Cookie', adminCookie)
      .send({ organizationId: null, name: 'P14 平台扩展', slug: extensionSlug, kind: 'agent', manifest: agentManifest(['knowledge.search']) })
      .expect(201);
    extId = created.body.data.extension.id as string;
    cleanupExtensionIds.push(extId);
    agentSlugs = [extensionAgentSlug(extensionSlug, orgM), extensionAgentSlug(extensionSlug, orgN)];
    versionId = (await request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/publish`).set(XRW).set('Cookie', adminCookie)
      .send({}).expect(201)).body.data.id as string;
  });

  afterAll(async () => {
    warnSpy.mockRestore();
    if (!app) return; // 初始化失败（如基础设施未就绪）时不掩盖原始错误
    const agents = await prisma.agent.findMany({ where: { slug: { in: agentSlugs } }, select: { id: true } });
    const agentIds = agents.map((a) => a.id);
    if (agentIds.length) {
      await prisma.agentVersion.deleteMany({ where: { agentId: { in: agentIds } } }).catch(() => undefined);
      await prisma.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => undefined);
    }
    if (cleanupExtensionIds.length) {
      await prisma.extensionOrgAllowlist.deleteMany({ where: { extensionId: { in: cleanupExtensionIds } } }).catch(() => undefined);
      await prisma.extensionInstallation.deleteMany({ where: { extensionId: { in: cleanupExtensionIds } } }).catch(() => undefined);
      await prisma.extensionVersion.deleteMany({ where: { extensionId: { in: cleanupExtensionIds } } }).catch(() => undefined);
      await prisma.extension.deleteMany({ where: { id: { in: cleanupExtensionIds } } }).catch(() => undefined);
    }
    for (const orgId of cleanupOrgIds) {
      await prisma.organizationInvitation.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.organizationMember.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } }).catch(() => undefined);
    await app.close();
  });

  // ===== D16：组织白名单 =====

  it('D16 ① 未配置白名单 = 对所有组织开放（安装成功且物化 Agent 工具为交集结果）', async () => {
    const allowlist = await request(app.getHttpServer()).get(`/api/v1/extensions/${extId}/allowlist`).set(XRW).set('Cookie', ownerNCookie).expect(200);
    expect(allowlist.body.data).toMatchObject({ restricted: false, items: [] });

    const installed = await request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/install`).set(XRW).set('Cookie', ownerMCookie)
      .send({ organizationId: orgM, versionId }).expect(201);
    expect(installed.body.data.installation.status).toBe('enabled');
    const agent = await prisma.agent.findUnique({ where: { slug: agentSlugs[0] }, include: { activeVersion: true } });
    expect(agent?.enabled).toBe(true);
    expect(agent?.activeVersion?.tools).toEqual(['knowledge.search']);

    // 另一组织同样可装（白名单为空 = 无组织级限制）
    await request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/install`).set(XRW).set('Cookie', ownerNCookie)
      .send({ organizationId: orgN, versionId }).expect(201);
  });

  it('D16 ② 配置白名单后仅白名单组织可用：非白名单组织安装 403（不落安装行）+ 收紧即时回收既有安装', async () => {
    const added = await request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/allowlist`).set(XRW).set('Cookie', adminCookie)
      .send({ organizationId: orgM }).expect(201);
    expect(added.body.data.disabledOrganizations).toContain(orgN);

    // 收紧立即生效：N 的既有安装被回收，物化 Agent 失效（绝不遗留可用能力）
    expect((await prisma.extensionInstallation.findUnique({
      where: { organizationId_extensionId: { organizationId: orgN, extensionId: extId } },
    }))?.status).toBe('disabled');
    expect((await prisma.agent.findUnique({ where: { slug: agentSlugs[1] } }))?.enabled).toBe(false);
    const reEnable = await request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/enable`).set(XRW).set('Cookie', ownerNCookie)
      .send({ organizationId: orgN });
    expect(reEnable.status).toBe(403);
    expect(reEnable.body.error?.code).toBe('FORBIDDEN');

    // 从未安装过的组织直接安装 → 403（扩展存在但未对该组织开放；且不落安装行）
    const orgN2 = (await request(app.getHttpServer()).post('/api/v1/organizations').set(XRW).set('Cookie', ownerNCookie)
      .send({ name: 'P14 外部组织 N2', slug: `prem10p14-n2-${stamp}` }).expect(201)).body.data.id as string;
    cleanupOrgIds.push(orgN2);
    const denied = await request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/install`).set(XRW).set('Cookie', ownerNCookie)
      .send({ organizationId: orgN2, versionId });
    expect(denied.status).toBe(403);
    expect(await prisma.extensionInstallation.findUnique({
      where: { organizationId_extensionId: { organizationId: orgN2, extensionId: extId } },
    })).toBeNull();

    // 白名单查询 = 只读治理数据：任何登录用户可读，restricted=true 且含 orgM
    const visible = await request(app.getHttpServer()).get(`/api/v1/extensions/${extId}/allowlist`).set(XRW).set('Cookie', ownerNCookie).expect(200);
    expect(visible.body.data.restricted).toBe(true);
    expect((visible.body.data.items as Array<{ organizationId: string }>).map((i) => i.organizationId)).toContain(orgM);
  });

  it('D16 ③ 白名单管理 RBAC 与 IDOR：仅 extension owner 可增；本组织 owner 可自助退出；跨组织增删 403', async () => {
    // 组织自加入（提权尝试）→ 403（否则任何组织都能给自己开权限，绕开扩展所有者的收紧决策）
    const selfAdd = await request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/allowlist`).set(XRW).set('Cookie', ownerNCookie)
      .send({ organizationId: orgN });
    expect(selfAdd.status).toBe(403);
    // 组织成员（无治理权）→ 403
    const memberAdd = await request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/allowlist`).set(XRW).set('Cookie', memberMCookie)
      .send({ organizationId: orgM });
    expect(memberAdd.status).toBe(403);

    // extension owner（平台管理员）可增条目；重复添加幂等（upsert）
    await request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/allowlist`).set(XRW).set('Cookie', adminCookie)
      .send({ organizationId: orgN }).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/allowlist`).set(XRW).set('Cookie', adminCookie)
      .send({ organizationId: orgN }).expect(201);

    // IDOR：外部组织 owner 删除**他组织**（orgM）条目 → 403；删除本组织条目 → 允许（自助退出，不构成提权）
    await request(app.getHttpServer()).delete(`/api/v1/extensions/${extId}/allowlist/${orgM}`).set(XRW).set('Cookie', ownerNCookie).expect(403);
    await request(app.getHttpServer()).delete(`/api/v1/extensions/${extId}/allowlist/${orgN}`).set(XRW).set('Cookie', ownerNCookie).expect(200);

    const after = await request(app.getHttpServer()).get(`/api/v1/extensions/${extId}/allowlist`).set(XRW).set('Cookie', adminCookie).expect(200);
    const ids = (after.body.data.items as Array<{ organizationId: string }>).map((i) => i.organizationId);
    expect(ids).toContain(orgM);
    expect(ids).not.toContain(orgN);
    // 删除条目不自动恢复（重新启用是显式动作）
    expect((await prisma.extensionInstallation.findUnique({
      where: { organizationId_extensionId: { organizationId: orgN, extensionId: extId } },
    }))?.status).toBe('disabled');
  });

  // ===== X-21：组织禁用态 =====

  it('X-21 ④ 治理端点 RBAC：仅平台管理员或组织 owner 可禁用/启用（成员/外部组织 403；个人空间不可自助禁用）', async () => {
    await request(app.getHttpServer()).post(`/api/v1/organizations/${orgM}/disable`).set(XRW).set('Cookie', memberMCookie).expect(403);
    await request(app.getHttpServer()).post(`/api/v1/organizations/${orgM}/disable`).set(XRW).set('Cookie', ownerNCookie).expect(403);

    const personal = await request(app.getHttpServer()).post(`/api/v1/organizations/${personalM}/disable`).set(XRW).set('Cookie', ownerMCookie);
    expect(personal.status).toBe(400);
    expect(personal.body.error?.code).toBe('VALIDATION_ERROR');
    expect((await prisma.organization.findUnique({ where: { id: personalM } }))?.status).toBe('active');
  });

  it('X-21 ⑤ 禁用后：组织端点与组织级扩展端点一律 403 ORG_DISABLED；只读治理数据不受影响', async () => {
    const disabled = await request(app.getHttpServer()).post(`/api/v1/organizations/${orgM}/disable`).set(XRW).set('Cookie', ownerMCookie).expect(201);
    expect(disabled.body.data).toMatchObject({ id: orgM, status: 'disabled', unchanged: false });
    expect((await prisma.organization.findUnique({ where: { id: orgM } }))?.status).toBe('disabled');

    // 组织端点：读 / 写 / 软删 / 成员 / 邀请 一律 403 ORG_DISABLED（成员与 owner 同待遇）
    for (const call of [
      request(app.getHttpServer()).get(`/api/v1/organizations/${orgM}`).set(XRW).set('Cookie', memberMCookie),
      request(app.getHttpServer()).get(`/api/v1/organizations/${orgM}/members`).set(XRW).set('Cookie', memberMCookie),
      request(app.getHttpServer()).patch(`/api/v1/organizations/${orgM}`).set(XRW).set('Cookie', ownerMCookie).send({ name: '改名尝试' }),
      request(app.getHttpServer()).delete(`/api/v1/organizations/${orgM}`).set(XRW).set('Cookie', ownerMCookie),
      request(app.getHttpServer()).post(`/api/v1/organizations/${orgM}/invitations`).set(XRW).set('Cookie', ownerMCookie).send({ email: `x-${stamp}@example.com` }),
      request(app.getHttpServer()).get(`/api/v1/organizations/${orgM}/invitations`).set(XRW).set('Cookie', ownerMCookie),
    ]) {
      const res = await call;
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('ORG_DISABLED');
    }

    // 组织级扩展端点（query/body 携带 organizationId）同样被守卫拒绝
    for (const call of [
      request(app.getHttpServer()).get('/api/v1/extensions').set(XRW).set('Cookie', memberMCookie).query({ organizationId: orgM }),
      request(app.getHttpServer()).get('/api/v1/extensions/catalog').set(XRW).set('Cookie', memberMCookie).query({ organizationId: orgM }),
      request(app.getHttpServer()).get('/api/v1/extensions/installations').set(XRW).set('Cookie', memberMCookie).query({ organizationId: orgM }),
      request(app.getHttpServer()).get('/api/v1/extensions/steps').set(XRW).set('Cookie', memberMCookie).query({ organizationId: orgM }),
      request(app.getHttpServer()).get(`/api/v1/extensions/${extId}`).set(XRW).set('Cookie', ownerMCookie).query({ organizationId: orgM }),
      request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/install`).set(XRW).set('Cookie', ownerMCookie).send({ organizationId: orgM, versionId }),
      request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/enable`).set(XRW).set('Cookie', ownerMCookie).send({ organizationId: orgM }),
      request(app.getHttpServer()).post(`/api/v1/extensions/${extId}/uninstall`).set(XRW).set('Cookie', ownerMCookie).send({ organizationId: orgM }),
    ]) {
      const res = await call;
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('ORG_DISABLED');
    }

    // 禁用是**统一冻结、无角色豁免**：平台管理员的数据面访问同样 403 ORG_DISABLED
    // （守卫不做角色豁免——否则任何 role=admin 令牌即绕过冻结；平台管理员的能力在治理端点）
    for (const call of [
      request(app.getHttpServer()).get(`/api/v1/organizations/${orgM}`).set(XRW).set('Cookie', adminCookie),
      request(app.getHttpServer()).get('/api/v1/extensions').set(XRW).set('Cookie', adminCookie).query({ organizationId: orgM }),
    ]) {
      const res = await call;
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('ORG_DISABLED');
    }

    // 只读治理数据不受影响：白名单查询（豁免端点）+ 组织列表（成员仍可见自己的组织 → 可自查/可恢复）
    expect((await request(app.getHttpServer()).get(`/api/v1/extensions/${extId}/allowlist`).set(XRW).set('Cookie', memberMCookie).expect(200))
      .body.data.restricted).toBe(true);
    const mine = await request(app.getHttpServer()).get('/api/v1/organizations').set(XRW).set('Cookie', memberMCookie).expect(200);
    expect((mine.body.data as Array<{ id: string }>).some((o) => o.id === orgM)).toBe(true);

    // 幂等：重复禁用不重复写库（目标态一致 → unchanged）
    expect((await request(app.getHttpServer()).post(`/api/v1/organizations/${orgM}/disable`).set(XRW).set('Cookie', ownerMCookie).expect(201))
      .body.data.unchanged).toBe(true);

    // 恢复：owner 重新启用（治理端点自身豁免禁用守卫 → 冻结可恢复）→ 访问恢复
    await request(app.getHttpServer()).post(`/api/v1/organizations/${orgM}/enable`).set(XRW).set('Cookie', ownerMCookie).expect(201);
    await request(app.getHttpServer()).get(`/api/v1/organizations/${orgM}`).set(XRW).set('Cookie', memberMCookie).expect(200);
    expect((await prisma.organization.findUnique({ where: { id: orgM } }))?.status).toBe('active');
  });

  it('X-21 ⑥ 禁用组织不可再接纳新成员（服务层 acceptInvitation → 403 ORG_DISABLED，成员行不写）', async () => {
    // 前置依赖（⑤ 结束时应恢复为 active）：显式断言，避免上一用例失败时在此产生迷惑性失败
    expect((await prisma.organization.findUnique({ where: { id: orgM } }))?.status).toBe('active');
    const token = await inviteTokenFor(`prem10p14-invitee-${stamp}@example.com`);
    // 平台管理员路径执行禁用（治理端点 RBAC 的另一条路径）
    await request(app.getHttpServer()).post(`/api/v1/organizations/${orgM}/disable`).set(XRW).set('Cookie', adminCookie).expect(201);

    // 邀请接受端点请求体无 organizationId → 守卫不判定；组织归属由邀请行解析 → 服务层裁决
    const denied = await request(app.getHttpServer()).post(`/api/v1/invitations/${token}/accept`).set(XRW).set('Cookie', inviteeCookie);
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe('ORG_DISABLED');
    expect(await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgM, userId: inviteeId } },
    })).toBeNull();

    // 平台管理员恢复 → 邀请可正常接受（冻结不吞掉有待处理的邀请）
    await request(app.getHttpServer()).post(`/api/v1/organizations/${orgM}/enable`).set(XRW).set('Cookie', adminCookie).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/invitations/${token}/accept`).set(XRW).set('Cookie', inviteeCookie).expect(201);
    expect(await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgM, userId: inviteeId } },
    })).toBeTruthy();
  });
});
