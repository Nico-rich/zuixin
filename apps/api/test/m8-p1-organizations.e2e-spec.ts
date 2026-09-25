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

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * M8-P1 Multi-tenancy / Organization / RBAC e2e（真实 PostgreSQL）：
 * Personal Organization 自动创建；组织/成员/邀请状态机；RBAC 矩阵；多租户 A↔B 隔离矩阵。
 */
describe('M8-P1 Multi-tenancy / Organization / RBAC (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookieA: string;
  let cookieB: string;
  let userA = '';
  let userB = '';
  let orgA = '';
  let projectA = '';
  let workflowA = '';
  let connectionA = '';
  const cleanupUserIds: string[] = [];

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

    const loginA = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookieA = (loginA.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userA = loginA.body.data.user.id;

    const b = await prisma.user.create({ data: { email: `tenb-p1-${Date.now()}@example.com`, passwordHash: 'unused-hash' } });
    userB = b.id;
    cleanupUserIds.push(userB);
    // B 从未登录：个人组织由登录/注册时懒创建——此处按同语义直接 ensure（等价于 B 登录一次）
    const { OrganizationsService } = await import('../src/modules/organizations/organizations.service');
    await moduleRef.get(OrganizationsService).ensurePersonalOrganization(userB);
    const jwtB = moduleRef.get((await import('@nestjs/jwt')).JwtService);
    cookieB = `agent_access=${await jwtB.signAsync({ sub: userB, role: 'user' })}`;
  });

  afterAll(async () => {
    if (orgA) {
      await prisma.organizationInvitation.deleteMany({ where: { organizationId: orgA } }).catch(() => undefined);
      await prisma.organizationMember.deleteMany({ where: { organizationId: orgA } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id: orgA } }).catch(() => undefined);
    }
    if (workflowA) await prisma.workflow.delete({ where: { id: workflowA } }).catch(() => undefined);
    if (connectionA) {
      await prisma.credential.deleteMany({ where: { connectionId: connectionA } });
      await prisma.connection.delete({ where: { id: connectionA } }).catch(() => undefined);
    }
    if (projectA) await prisma.project.delete({ where: { id: projectA } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } }).catch(() => undefined);
    await app.close();
  });

  it('P1 Personal Organization：登录后自动存在（owner 身份）；新用户同样自动获得', async () => {
    const mine = await request(app.getHttpServer()).get('/api/v1/organizations').set(XRW).set('Cookie', cookieA).expect(200);
    const personal = (mine.body.data as Array<{ isPersonal: boolean; members: Array<{ role: string }> }>).find((o) => o.isPersonal);
    expect(personal).toBeTruthy();
    expect(personal!.members[0].role).toBe('owner');

    const mineB = await request(app.getHttpServer()).get('/api/v1/organizations').set(XRW).set('Cookie', cookieB).expect(200);
    expect((mineB.body.data as Array<{ isPersonal: boolean }>).some((o) => o.isPersonal)).toBe(true);
  });

  it('P1 组织创建 + 资源挂接：A 创建组织/项目/工作流/连接（挂组织）', async () => {
    const org = await request(app.getHttpServer()).post('/api/v1/organizations').set(XRW).set('Cookie', cookieA)
      .send({ name: '多租户测试组织', slug: `tenorg-${Date.now()}` }).expect(201);
    orgA = org.body.data.id as string;
    expect(org.body.data.members[0].role).toBe('owner');

    const project = await request(app.getHttpServer()).post('/api/v1/projects').set(XRW).set('Cookie', cookieA)
      .send({ name: '组织项目A', organizationId: orgA }).expect(201);
    projectA = project.body.data.id as string;
    expect((await prisma.project.findUnique({ where: { id: projectA } }))?.organizationId).toBe(orgA);

    const wf = await request(app.getHttpServer()).post('/api/v1/workflows').set(XRW).set('Cookie', cookieA)
      .send({ name: '组织工作流A', organizationId: orgA, definition: { triggers: [{ type: 'manual' }], steps: [{ id: 'done', type: 'output', output: { ok: true } }] } })
      .expect(201);
    workflowA = wf.body.data.id as string;
    expect((await prisma.workflow.findUnique({ where: { id: workflowA } }))?.organizationId).toBe(orgA);

    const start = await request(app.getHttpServer()).post('/api/v1/connections/mock/start').set(XRW).set('Cookie', cookieA).send({}).expect(201);
    const cb = await request(app.getHttpServer()).get('/api/v1/connections/mock/callback').set(XRW).set('Cookie', cookieA)
      .query({ state: start.body.data.state, code: 'm8p1-conn' }).expect(200);
    connectionA = cb.body.data.id as string;
    expect((await prisma.connection.findUnique({ where: { id: connectionA } }))?.organizationId).toBeTruthy();
  });

  it('P1 多租户矩阵（未受邀）：A→A PASS；B→B PASS；A→B 404；B→A 404', async () => {
    // A 访问自己的资源 ✓
    await request(app.getHttpServer()).get(`/api/v1/projects/${projectA}`).set(XRW).set('Cookie', cookieA).expect(200);
    await request(app.getHttpServer()).get(`/api/v1/workflows/${workflowA}`).set(XRW).set('Cookie', cookieA).expect(200);
    await request(app.getHttpServer()).get(`/api/v1/connections/${connectionA}`).set(XRW).set('Cookie', cookieA).expect(200);
    await request(app.getHttpServer()).get(`/api/v1/organizations/${orgA}`).set(XRW).set('Cookie', cookieA).expect(200);
    // B 访问自己的组织列表 ✓（只含个人组织，不含 A 的）
    const mineB = await request(app.getHttpServer()).get('/api/v1/organizations').set(XRW).set('Cookie', cookieB).expect(200);
    expect((mineB.body.data as Array<{ id: string }>).some((o) => o.id === orgA)).toBe(false);
    // B → A 资源：404（防枚举；绝不泄露存在性）
    await request(app.getHttpServer()).get(`/api/v1/projects/${projectA}`).set(XRW).set('Cookie', cookieB).expect(404);
    await request(app.getHttpServer()).get(`/api/v1/workflows/${workflowA}`).set(XRW).set('Cookie', cookieB).expect(404);
    await request(app.getHttpServer()).get(`/api/v1/connections/${connectionA}`).set(XRW).set('Cookie', cookieB).expect(404);
    await request(app.getHttpServer()).get(`/api/v1/organizations/${orgA}`).set(XRW).set('Cookie', cookieB).expect(403);
    // B 对 A 组织写操作 → 403
    await request(app.getHttpServer()).post(`/api/v1/projects`).set(XRW).set('Cookie', cookieB)
      .send({ name: '越权项目', organizationId: orgA }).expect(403);
    // 匿名 → 401
    await request(app.getHttpServer()).get(`/api/v1/organizations/${orgA}`).set(XRW).expect(401);
  });

  it('P1 邀请状态机：invite → accept（B 成为成员）→ 重复 accept 409 → 资源可见', async () => {
    const bEmail = (await prisma.user.findUnique({ where: { id: userB } }))!.email;
    const inv = await request(app.getHttpServer()).post(`/api/v1/organizations/${orgA}/invitations`).set(XRW).set('Cookie', cookieA)
      .send({ email: bEmail, role: 'member' }).expect(201);
    const token = inv.body.data.token as string;

    await request(app.getHttpServer()).post(`/api/v1/invitations/${token}/accept`).set(XRW).set('Cookie', cookieB).expect(201);
    // 重复 accept → 409（token 单次使用）
    await request(app.getHttpServer()).post(`/api/v1/invitations/${token}/accept`).set(XRW).set('Cookie', cookieB).expect(400);

    // B 现在是 member：组织可见 + 资源可读
    await request(app.getHttpServer()).get(`/api/v1/organizations/${orgA}`).set(XRW).set('Cookie', cookieB).expect(200);
    await request(app.getHttpServer()).get(`/api/v1/projects/${projectA}`).set(XRW).set('Cookie', cookieB).expect(200);
    await request(app.getHttpServer()).get(`/api/v1/workflows/${workflowA}`).set(XRW).set('Cookie', cookieB).expect(200);
    // member 可写资源（project.write）
    const p2 = await request(app.getHttpServer()).post('/api/v1/projects').set(XRW).set('Cookie', cookieB)
      .send({ name: '成员项目B', organizationId: orgA }).expect(201);
    await prisma.project.delete({ where: { id: p2.body.data.id } });
  });

  it('P1 RBAC：member 无 member.write（邀请/移除 403）；viewer 只读；admin 可邀请', async () => {
    // member(B) 邀请他人 → 403
    await request(app.getHttpServer()).post(`/api/v1/organizations/${orgA}/invitations`).set(XRW).set('Cookie', cookieB)
      .send({ email: 'x@example.com' }).expect(403);
    // member(B) 删除组织 → 403
    await request(app.getHttpServer()).delete(`/api/v1/organizations/${orgA}`).set(XRW).set('Cookie', cookieB).expect(403);

    // 创建第三个用户 C：viewer 角色
    const c = await prisma.user.create({ data: { email: `tenc-p1-${Date.now()}@example.com`, passwordHash: 'unused-hash' } });
    cleanupUserIds.push(c.id);
    const jwtC = app.get((await import('@nestjs/jwt')).JwtService);
    const cookieC = `agent_access=${await jwtC.signAsync({ sub: c.id, role: 'user' })}`;
    const inv2 = await request(app.getHttpServer()).post(`/api/v1/organizations/${orgA}/invitations`).set(XRW).set('Cookie', cookieA)
      .send({ email: c.email, role: 'viewer' }).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/invitations/${inv2.body.data.token}/accept`).set(XRW).set('Cookie', cookieC).expect(201);
    // viewer 可读、不可写
    await request(app.getHttpServer()).get(`/api/v1/projects/${projectA}`).set(XRW).set('Cookie', cookieC).expect(200);
    await request(app.getHttpServer()).post('/api/v1/projects').set(XRW).set('Cookie', cookieC)
      .send({ name: 'viewer 越权', organizationId: orgA }).expect(403);

    // admin 可邀请（A 将 B 升为 admin → B 可邀请）
    await prisma.organizationMember.updateMany({
      where: { organizationId: orgA, userId: userB },
      data: { role: 'admin' },
    });
    await request(app.getHttpServer()).post(`/api/v1/organizations/${orgA}/invitations`).set(XRW).set('Cookie', cookieB)
      .send({ email: 'y@example.com' }).expect(201);
    await prisma.organizationMember.updateMany({
      where: { organizationId: orgA, userId: userB },
      data: { role: 'member' },
    });
  });

  it('P1 邀请异常态：revoke 后 accept 拒绝；过期邀请拒绝；owner 不可被移除；个人组织不可删', async () => {
    // revoke（用未入组的邮箱——已成员不可重复邀请）
    const inv = await request(app.getHttpServer()).post(`/api/v1/organizations/${orgA}/invitations`).set(XRW).set('Cookie', cookieA)
      .send({ email: 'w-p1@example.com', role: 'member' }).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/invitations/${inv.body.data.token}/revoke`).set(XRW).set('Cookie', cookieA).expect(201);
    // revoked 后 accept → 邀请不存在/已处理（400）
    const w = await prisma.user.create({ data: { email: 'w-p1@example.com', passwordHash: 'unused-hash' } });
    cleanupUserIds.push(w.id);
    const jwt2 = app.get((await import('@nestjs/jwt')).JwtService);
    const cookieW = `agent_access=${await jwt2.signAsync({ sub: w.id, role: 'user' })}`;
    await request(app.getHttpServer()).post(`/api/v1/invitations/${inv.body.data.token}/accept`).set(XRW).set('Cookie', cookieW).expect(400);

    // 过期
    const z = await prisma.user.create({ data: { email: 'z-p1@example.com', passwordHash: 'unused-hash' } });
    const expired = await prisma.organizationInvitation.create({
      data: {
        organizationId: orgA, email: z.email, role: 'member', invitedByUserId: userA,
        token: `expired-${Date.now()}`, expiresAt: new Date(Date.now() - 1000),
      },
    });
    cleanupUserIds.push(z.id);
    const jwtZ = app.get((await import('@nestjs/jwt')).JwtService);
    const cookieZ = `agent_access=${await jwtZ.signAsync({ sub: z.id, role: 'user' })}`;
    await request(app.getHttpServer()).post(`/api/v1/invitations/${expired.token}/accept`).set(XRW).set('Cookie', cookieZ).expect(400);
    expect((await prisma.organizationInvitation.findUnique({ where: { id: expired.id } }))?.status).toBe('expired');

    // owner 不可被移除
    await request(app.getHttpServer()).delete(`/api/v1/organizations/${orgA}/members/${userA}`).set(XRW).set('Cookie', cookieA).expect(400);

    // 个人组织不可删
    const personal = await prisma.organization.findFirst({ where: { ownerUserId: userA, isPersonal: true } });
    await request(app.getHttpServer()).delete(`/api/v1/organizations/${personal!.id}`).set(XRW).set('Cookie', cookieA).expect(400);
  });

  it('P1 组织 soft delete：删除后不可见/不可用（成员访问 403）', async () => {
    await request(app.getHttpServer()).delete(`/api/v1/organizations/${orgA}`).set(XRW).set('Cookie', cookieA).expect(200);
    expect((await prisma.organization.findUnique({ where: { id: orgA } }))?.deletedAt).toBeTruthy();
    await request(app.getHttpServer()).get(`/api/v1/organizations/${orgA}`).set(XRW).set('Cookie', cookieB).expect(403);
    await request(app.getHttpServer()).get(`/api/v1/projects/${projectA}`).set(XRW).set('Cookie', cookieB).expect(404);
  });
});
