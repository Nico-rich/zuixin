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
const STAMP = Date.now();
/** 最小合法定义（manual 触发器不注册任何外部触发器 → 清理面最小） */
const DEFINITION = {
  triggers: [{ type: 'manual' }],
  steps: [{ id: 'out', type: 'output', output: { ok: true } }],
};

/**
 * Pre-M9 安全回归（P0）：Workflow 写端点 RBAC（viewer/member 可写）
 *
 * 修复前 create/update/publish/archive/remove 共用 requireOwned（"本人或组织成员"）——组织内的
 * viewer 与 member 都能改流程。期望：写操作按 workflow.write 裁决（与 Project RBAC 同语义）：
 *   - viewer（只读角色）→ 403；member（含 workflow.write）→ 允许；
 *   - 非成员（另一组织）→ 404 反枚举（读/写一致，不泄露存在性）；
 *   - 个人流程（无 organizationId，只有 ownerUserId）→ 仅创建者本人可写，不被误伤；
 *   - 读路径不变：viewer 仍可 GET。
 */
describe('Pre-M9 Workflow 写端点 RBAC (e2e, 真实 PG)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookieOwner: string; // orgA owner（种子 admin）
  let cookieMember: string; // orgA member（workflow.write）
  let cookieViewer: string; // orgA viewer（只读）
  let cookieOutsider: string; // 非 orgA 成员（另一用户）
  let orgA = '';
  let workflowId = ''; // orgA 组织流程
  let personalWorkflowId = ''; // owner 的个人流程（无组织显式指定 → 个人组织）
  const cleanupUserIds: string[] = [];
  const cleanupWorkflowIds: string[] = []; // 本套件自建行（绝不按名字模糊删——不碰并行的其他套件）

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
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookieOwner = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');

    // 组织 + 三个独立用户（member/viewer 直接在成员表落角色；outsider 完全不属该组织）
    const org = await request(app.getHttpServer()).post('/api/v1/organizations').set(XRW).set('Cookie', cookieOwner)
      .send({ name: `prem9-wf-org-${STAMP}` }).expect(201);
    orgA = org.body.data.id as string;
    const mkUser = async (tag: string, role: 'member' | 'viewer' | null) => {
      const u = await prisma.user.create({ data: { email: `prem9-wf-${tag}-${STAMP}@example.com`, passwordHash: 'unused-hash' } });
      cleanupUserIds.push(u.id);
      if (role) await prisma.organizationMember.create({ data: { organizationId: orgA, userId: u.id, role } });
      return `agent_access=${await jwt.signAsync({ sub: u.id, role: 'user' })}`;
    };
    cookieMember = await mkUser('member', 'member');
    cookieViewer = await mkUser('viewer', 'viewer');
    cookieOutsider = await mkUser('outsider', null);

    // orgA 组织流程（owner 创建）；个人流程（不传 organizationId → 服务端解析个人组织）
    const created = await request(app.getHttpServer()).post('/api/v1/workflows').set(XRW).set('Cookie', cookieOwner)
      .send({ name: `prem9 wf org ${STAMP}`, organizationId: orgA, definition: DEFINITION }).expect(201);
    workflowId = created.body.data.id as string;
    cleanupWorkflowIds.push(workflowId);
    const personal = await request(app.getHttpServer()).post('/api/v1/workflows').set(XRW).set('Cookie', cookieOwner)
      .send({ name: `prem9 wf personal ${STAMP}`, definition: DEFINITION }).expect(201);
    personalWorkflowId = personal.body.data.id as string;
    cleanupWorkflowIds.push(personalWorkflowId);
  }, 60_000);

  afterAll(async () => {
    await prisma.workflow.deleteMany({ where: { id: { in: cleanupWorkflowIds } } }).catch(() => undefined);
    if (orgA) {
      await prisma.organizationMember.deleteMany({ where: { organizationId: orgA } }).catch(() => undefined);
      await prisma.organization.deleteMany({ where: { id: orgA } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } }).catch(() => undefined);
    await app.close();
  });

  it('P0 ①：viewer 可读但不可写——update/publish/archive/delete 全部 403（且零副作用）', async () => {
    await request(app.getHttpServer()).get(`/api/v1/workflows/${workflowId}`).set(XRW).set('Cookie', cookieViewer).expect(200); // 读路径不变

    for (const attempt of [
      request(app.getHttpServer()).patch(`/api/v1/workflows/${workflowId}`).set(XRW).set('Cookie', cookieViewer).send({ name: 'viewer 越权改名' }),
      request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/publish`).set(XRW).set('Cookie', cookieViewer).send({}),
      request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/archive`).set(XRW).set('Cookie', cookieViewer).send({}),
      request(app.getHttpServer()).delete(`/api/v1/workflows/${workflowId}`).set(XRW).set('Cookie', cookieViewer),
    ]) {
      const res = await attempt;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }

    // 零副作用：名称/状态/版本数均未被 viewer 改动（校验发生在操作之前）
    const row = await prisma.workflow.findUnique({ where: { id: workflowId }, include: { versions: true } });
    expect(row!.name).toBe(`prem9 wf org ${STAMP}`);
    expect(row!.status).toBe('draft');
    expect(row!.versions.length).toBe(1);
  });

  it('P0 ②：member（有 workflow.write）可写——update → publish → archive 全部成功', async () => {
    const updated = await request(app.getHttpServer()).patch(`/api/v1/workflows/${workflowId}`).set(XRW).set('Cookie', cookieMember)
      .send({ name: `prem9 wf org renamed ${STAMP}`, definition: DEFINITION }).expect(200);
    expect(updated.body.data.name).toBe(`prem9 wf org renamed ${STAMP}`);

    await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/publish`).set(XRW).set('Cookie', cookieMember).send({}).expect(201);
    expect((await prisma.workflow.findUnique({ where: { id: workflowId } }))!.status).toBe('published');

    await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/archive`).set(XRW).set('Cookie', cookieMember).send({}).expect(201);
    expect((await prisma.workflow.findUnique({ where: { id: workflowId } }))!.status).toBe('archived');
  });

  it('P0 ③：非成员（另一用户）→ 404 反枚举（读/写一致，不泄露存在性）', async () => {
    await request(app.getHttpServer()).get(`/api/v1/workflows/${workflowId}`).set(XRW).set('Cookie', cookieOutsider).expect(404);
    for (const attempt of [
      request(app.getHttpServer()).patch(`/api/v1/workflows/${workflowId}`).set(XRW).set('Cookie', cookieOutsider).send({ name: 'outsider 改名' }),
      request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/publish`).set(XRW).set('Cookie', cookieOutsider).send({}),
      request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/archive`).set(XRW).set('Cookie', cookieOutsider).send({}),
      request(app.getHttpServer()).delete(`/api/v1/workflows/${workflowId}`).set(XRW).set('Cookie', cookieOutsider),
    ]) {
      const res = await attempt;
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain(`prem9 wf org renamed ${STAMP}`); // 零字段泄漏
    }
    expect(await prisma.workflow.count({ where: { id: workflowId } })).toBe(1); // 未被删除
  });

  it('P0 ④：create 亦按 workflow.write 裁决——viewer 挂组织建流 403；member 201', async () => {
    await request(app.getHttpServer()).post('/api/v1/workflows').set(XRW).set('Cookie', cookieViewer)
      .send({ name: `prem9 wf viewer ${STAMP}`, organizationId: orgA, definition: DEFINITION }).expect(403);
    expect(await prisma.workflow.count({ where: { name: `prem9 wf viewer ${STAMP}` } })).toBe(0);

    const byMember = await request(app.getHttpServer()).post('/api/v1/workflows').set(XRW).set('Cookie', cookieMember)
      .send({ name: `prem9 wf member ${STAMP}`, organizationId: orgA, definition: DEFINITION }).expect(201);
    cleanupWorkflowIds.push(byMember.body.data.id as string);
    expect((await prisma.workflow.findUnique({ where: { id: byMember.body.data.id as string } }))!.organizationId).toBe(orgA);
  });

  it('P0 ⑤：个人流程不误伤——owner 无 organizationId 建流后仍可 update/publish/delete；他人 404', async () => {
    await request(app.getHttpServer()).patch(`/api/v1/workflows/${personalWorkflowId}`).set(XRW).set('Cookie', cookieOwner)
      .send({ name: `prem9 wf personal renamed ${STAMP}` }).expect(200);
    await request(app.getHttpServer()).post(`/api/v1/workflows/${personalWorkflowId}/publish`).set(XRW).set('Cookie', cookieOwner).send({}).expect(201);
    // 非本人（即便同为某组织成员）不可写个人流程 → 404
    await request(app.getHttpServer()).post(`/api/v1/workflows/${personalWorkflowId}/publish`).set(XRW).set('Cookie', cookieOutsider).send({}).expect(404);
    await request(app.getHttpServer()).delete(`/api/v1/workflows/${personalWorkflowId}`).set(XRW).set('Cookie', cookieOwner).expect(200);
    expect(await prisma.workflow.count({ where: { id: personalWorkflowId } })).toBe(0);
  });
});
