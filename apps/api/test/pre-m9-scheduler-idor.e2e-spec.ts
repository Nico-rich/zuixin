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
import { SchedulerService } from '../src/modules/scheduler/scheduler.service';
import { OrganizationsService } from '../src/modules/organizations/organizations.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
/** 唯一标记串：出现在受害者的 payload 里，任何响应体都绝不能包含它 */
const STAMP = Date.now();
const KEY = `prem9-idor-key-${STAMP}`;
const SECRET = `prem9-idor-secret-${STAMP}`;
const VICTIM_NAME = `A 的私有作业 ${STAMP}`;

/**
 * Pre-M9 安全回归（P0）：Scheduler 幂等键 IDOR（跨组织越权读）
 *
 * ScheduledJob.idempotencyKey 是**全局唯一**约束（schema 冻结，不可改）。若幂等命中只按 idempotencyKey
 * 查行，任何登录用户猜到/复用他人的键即可：① 拿到他人的作业行（含 payload/name/handler/traceId）；
 * ② 收到 created:false 造成"键被抢占"（真正的创建者之后无法再用该键入队）。
 *
 * 期望：幂等命中限定在调用方 scope（organizationId + ownerUserId）内；同 scope 同键 → 幂等返回
 * （created:false + 同一 id，不重复入队）；scope 外撞键（含全局唯一冲突 P2002 兜底路径）→ 404 反枚举，
 * 响应体零字段泄漏、库中行绝不被改写/抢占。
 */
describe('Pre-M9 Scheduler 幂等键 IDOR (e2e, 真实 PG/Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let scheduler: SchedulerService;
  let cookieA: string; // orgA 的 owner（种子 admin）
  let cookieB: string; // orgA 的 member（同组织、不同用户）
  let userIdA = '';
  let userIdB = '';
  let personalOrgA = ''; // A 的个人组织（另一个 scope，仅作 404 探针，绝不写入）
  let orgA = ''; // 测试专用组织（A=owner，B=member）
  let orgB = ''; // B 的个人组织（另一个 scope）
  let victimJobId = '';
  const jobIds: string[] = [];
  const cleanupOrgIds: string[] = [];
  const cleanupUserIds: string[] = [];

  /** 泄漏断言：响应体不得出现受害者作业的任何字段（payload 标记串/id/name） */
  function expectNoLeak(body: unknown) {
    const raw = JSON.stringify(body ?? {});
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(victimJobId);
    expect(raw).not.toContain(VICTIM_NAME);
    expect(raw).not.toContain('noop'); // handler 亦属作业行字段
  }

  /** 同一份请求体、同一把键，只换调用方 scope（organizationId 由 cookie 对应组织解析） */
  function scheduleBody(organizationId: string, name: string, payload: Record<string, unknown>) {
    return {
      name, handler: 'noop', type: 'delayed',
      runAt: Date.now() + 3_600_000, // 远未来：本套件无 Worker，不会被执行
      idempotencyKey: KEY, payload, organizationId,
    };
  }

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
    scheduler = moduleRef.get(SchedulerService);
    const orgs = moduleRef.get(OrganizationsService);

    // A：种子 admin（登录 → 个人组织），再建一个测试专用组织（A 为 owner）
    const loginA = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookieA = (loginA.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userIdA = loginA.body.data.user.id as string;
    personalOrgA = (await orgs.ensurePersonalOrganization(userIdA)).id; // 共享资源：只读探针，绝不写入/删除
    const org = await request(app.getHttpServer()).post('/api/v1/organizations').set(XRW).set('Cookie', cookieA)
      .send({ name: `prem9-idor-org-${STAMP}` }).expect(201);
    orgA = org.body.data.id as string;
    cleanupOrgIds.push(orgA);

    // B：独立用户（JWT 直签，避免留下可登录账号）+ 个人组织；并以 member 身份加入 orgA（有 workflow.write）
    const b = await prisma.user.create({ data: { email: `prem9-idor-b-${STAMP}@example.com`, passwordHash: 'unused-hash' } });
    userIdB = b.id;
    cleanupUserIds.push(userIdB);
    const { JwtService } = await import('@nestjs/jwt');
    cookieB = `agent_access=${await moduleRef.get(JwtService).signAsync({ sub: userIdB, role: 'user' })}`;
    orgB = (await orgs.ensurePersonalOrganization(userIdB)).id;
    cleanupOrgIds.push(orgB);
    await prisma.organizationMember.create({ data: { organizationId: orgA, userId: userIdB, role: 'member' } });
  }, 60_000);

  afterAll(async () => {
    // 队列残留清理（延迟 job）——共享 Redis，绝不留给后续套件
    for (const id of jobIds) await scheduler.removeQueuedJobs(id).catch(() => undefined);
    await prisma.scheduledJob.deleteMany({ where: { id: { in: jobIds } } }).catch(() => undefined);
    await prisma.scheduledJob.deleteMany({ where: { idempotencyKey: KEY } }).catch(() => undefined);
    for (const orgId of cleanupOrgIds) {
      await prisma.organizationMember.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } }).catch(() => undefined);
    await app.close();
  });

  it('P0 ①：同键跨 scope（他人用户/他人组织）→ 404 反枚举；响应体零字段泄漏；库中行不被抢占', async () => {
    // scope A（orgA + userA）：正常创建（payload 内含唯一标记串）
    const first = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA)
      .send(scheduleBody(orgA, VICTIM_NAME, { secret: SECRET })).expect(201);
    victimJobId = first.body.data.job.id as string;
    jobIds.push(victimJobId);
    expect(first.body.data.created).toBe(true);

    // scope B（同组织、不同用户）：复用同一个键 → 404（键属于 A）——旧实现会返回 A 的行 + created:false
    const byMember = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieB)
      .send(scheduleBody(orgA, 'B 抢键', { secret: 'b-probe' })).expect(404);
    expect(byMember.body.error.code).toBe('NOT_FOUND');
    expectNoLeak(byMember.body);

    // scope C（同用户、另一个组织）：同样 404——此路径必经"全局唯一冲突 P2002 → 按 scope 复查明不中"
    const byOtherOrg = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA)
      .send(scheduleBody(personalOrgA, 'A 换组织抢键', { secret: 'c-probe' })).expect(404);
    expect(byOtherOrg.body.error.code).toBe('NOT_FOUND');
    expectNoLeak(byOtherOrg.body);

    // scope D（另一用户、另一组织）：404
    const byOtherUser = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieB)
      .send(scheduleBody(orgB, 'B 换组织抢键', { secret: 'd-probe' })).expect(404);
    expect(byOtherUser.body.error.code).toBe('NOT_FOUND');
    expectNoLeak(byOtherUser.body);

    // 事实不变：全局仅一行，且仍是 A 的组织/用户与原始字段（既未被读走，也未被抢占改键）
    const rows = await prisma.scheduledJob.findMany({ where: { idempotencyKey: KEY } });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(victimJobId);
    expect(rows[0].organizationId).toBe(orgA);
    expect(rows[0].ownerUserId).toBe(userIdA);
    expect(rows[0].name).toBe(VICTIM_NAME);
    expect((rows[0].payload as { secret: string }).secret).toBe(SECRET);
  });

  it('P0 ②：同 scope 重复 → 仍幂等（created:false + 同一 id，绝不第二个作业）', async () => {
    const again = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA)
      .send(scheduleBody(orgA, VICTIM_NAME, { secret: SECRET })).expect(201);
    expect(again.body.data.created).toBe(false);
    expect(again.body.data.job.id).toBe(victimJobId);
    expect(await prisma.scheduledJob.count({ where: { idempotencyKey: KEY } })).toBe(1);
  });

  it('P0 ③：修复不误伤正常路径——owner 仍可读列表、可取消自己的作业', async () => {
    const list = await request(app.getHttpServer()).get('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA)
      .query({ organizationId: orgA }).expect(200);
    expect((list.body.data.jobs as Array<{ id: string }>).some((j) => j.id === victimJobId)).toBe(true);

    await request(app.getHttpServer()).post(`/api/v1/scheduler/jobs/${victimJobId}/cancel`).set(XRW).set('Cookie', cookieA).expect(201);
    expect((await prisma.scheduledJob.findUnique({ where: { id: victimJobId } }))!.status).toBe('cancelled');

    // 非该组织成员（B 对 A 的个人组织无成员身份）→ 403（既有 RBAC 语义不变）
    await request(app.getHttpServer()).get('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieB)
      .query({ organizationId: personalOrgA }).expect(403);
  });
});
