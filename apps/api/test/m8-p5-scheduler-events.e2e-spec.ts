import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { SCHEDULER_QUEUE } from '../src/core/queue/scheduler-queue.module';
import { SchedulerService } from '../src/modules/scheduler/scheduler.service';
import { EventPlatformService } from '../src/modules/events/event-platform.service';
import { OrganizationsService } from '../src/modules/organizations/organizations.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

async function waitForJob(prisma: PrismaService, id: string, targets: string[], timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'missing';
  while (Date.now() < deadline) {
    const row = await prisma.scheduledJob.findUnique({ where: { id } });
    last = row?.status ?? 'missing';
    if (row && targets.includes(row.status)) return row.status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`ScheduledJob ${id} 未在 ${timeoutMs}ms 内到达 ${targets.join('/')}（当前 ${last}）`);
}

async function waitForEvent(prisma: PrismaService, eventId: string, targets: string[], timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'missing';
  while (Date.now() < deadline) {
    const row = await prisma.eventEnvelope.findUnique({ where: { eventId } });
    last = row?.status ?? 'missing';
    if (row && targets.includes(row.status)) return row.status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`EventEnvelope ${eventId} 未在 ${timeoutMs}ms 内到达 ${targets.join('/')}（当前 ${last}）`);
}

/**
 * M8-P5 Scheduler / Event Platform e2e（真实 PostgreSQL/Redis/BullMQ/Worker）：
 * ① delayed 作业按 runAt 触发 → completed（1.5s 内）；② 幂等键重复 → 同一行；
 * ③ 失败重试至 maxAttempts → dead + lastError；未注册 handler → dead（绝不执行任意代码）；
 * ④ 事件 publish → 订阅消费 consumed；重复 eventId 幂等单行；消费失败 → dead → redeliver 恢复；
 * ⑤ 组织隔离（他人 org 403）；recurring repeatable 注册/取消；pause/resume 不执行。
 */
describe('M8-P5 Scheduler / Event Platform (e2e, 真实 Redis/BullMQ/Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let queue: Queue;
  let cookieA: string;
  let cookieB: string;
  let userIdA = '';
  let userIdB = '';
  let orgA = ''; // A 的个人组织（作业/事件归属）
  let orgB = ''; // B 的个人组织（隔离对照组）
  const jobIds: string[] = [];
  const eventIds: string[] = [];
  const cleanupUserIds: string[] = [];
  const cleanupOrgIds: string[] = [];

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
    queue = moduleRef.get<Queue>(getQueueToken(SCHEDULER_QUEUE));

    const loginA = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookieA = (loginA.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userIdA = loginA.body.data.user.id;
    const orgs = moduleRef.get(OrganizationsService);
    orgA = (await orgs.ensurePersonalOrganization(userIdA)).id;

    const b = await prisma.user.create({ data: { email: `p5-userb-${Date.now()}@example.com`, passwordHash: 'unused-hash' } });
    userIdB = b.id;
    cleanupUserIds.push(userIdB);
    orgB = (await orgs.ensurePersonalOrganization(userIdB)).id;
    cleanupOrgIds.push(orgB);
    const { JwtService } = await import('@nestjs/jwt');
    cookieB = `agent_access=${await moduleRef.get(JwtService).signAsync({ sub: userIdB, role: 'user' })}`;

    // 真实 Worker 进程（消费 'scheduler' 队列）
    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
    // 测试 handler 注册在 worker 侧（执行方注册表才是权威）：e2e.fail 恒失败
    worker.get(SchedulerService).registerHandler('e2e.fail', () => { throw new Error('e2e 故意失败'); });
  }, 60_000);

  afterAll(async () => {
    // 队列残留清理（延迟/重复/重投变体）——避免污染后续套件
    const scheduler = app.get(SchedulerService);
    for (const id of jobIds) {
      await scheduler.removeQueuedJobs(id).catch(() => undefined);
      await scheduler.removeRepeatable(id).catch(() => undefined);
    }
    await prisma.scheduledJob.deleteMany({ where: { id: { in: jobIds } } }).catch(() => undefined);
    await prisma.eventEnvelope.deleteMany({ where: { eventId: { in: eventIds } } }).catch(() => undefined);
    await prisma.eventEnvelope.deleteMany({ where: { eventId: { startsWith: 'sched:' } } }).catch(() => undefined);
    await prisma.organizationMember.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } }).catch(() => undefined);
    await worker?.close();
    await app.close();
  });

  it('P5 ① delayed 作业：runAt=now+1s → 1.5s 内 completed（真实 BullMQ delayed + Worker）', async () => {
    const runAt = Date.now() + 1000;
    const res = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA)
      .send({ name: '延迟作业', handler: 'noop', type: 'delayed', runAt, organizationId: orgA }).expect(201);
    const jobId = res.body.data.job.id as string;
    jobIds.push(jobId);
    expect(res.body.data.created).toBe(true);
    expect(res.body.data.job.status).toBe('scheduled');

    const started = Date.now();
    expect(await waitForJob(prisma, jobId, ['completed'], 1500)).toBe('completed');
    const row = await prisma.scheduledJob.findUnique({ where: { id: jobId } });
    expect(row!.attempts).toBe(1);
    expect(row!.completedAt).toBeTruthy();
    expect(Date.now() - started).toBeLessThanOrEqual(1500);
  });

  it('P5 ② 幂等：同 idempotencyKey schedule 两次 → 同一行（绝不第二个作业）', async () => {
    const key = `p5-idem-${Date.now()}`;
    const body = { name: '幂等作业', handler: 'noop', type: 'delayed', runAt: Date.now() + 3_600_000, idempotencyKey: key, organizationId: orgA };
    const first = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA).send(body).expect(201);
    const second = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA).send(body).expect(201);
    const id = first.body.data.job.id as string;
    jobIds.push(id);
    expect(first.body.data.created).toBe(true);
    expect(second.body.data.created).toBe(false);
    expect(second.body.data.job.id).toBe(id);
    expect(await prisma.scheduledJob.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it('P5 ③ 失败作业：重试至 maxAttempts → dead + lastError；未注册 handler → dead（绝不执行任意代码）', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA)
      .send({ name: '失败作业', handler: 'e2e.fail', type: 'one-shot', runAt: Date.now(), maxAttempts: 2, backoffMs: 50, organizationId: orgA })
      .expect(201);
    const jobId = res.body.data.job.id as string;
    jobIds.push(jobId);
    expect(await waitForJob(prisma, jobId, ['dead'], 15_000)).toBe('dead');
    const row = await prisma.scheduledJob.findUnique({ where: { id: jobId } });
    expect(row!.attempts).toBe(2); // 恰好 maxAttempts 次，绝不无限重试
    expect(row!.lastError).toContain('e2e 故意失败');

    // 未注册 handler：worker 侧认不出 → dead（handler 名称是注册表键，绝不当代码执行）
    const unknown = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA)
      .send({ name: '未注册 handler', handler: 'e2e.not-registered', type: 'one-shot', runAt: Date.now(), maxAttempts: 1, organizationId: orgA })
      .expect(201);
    const unknownId = unknown.body.data.job.id as string;
    jobIds.push(unknownId);
    expect(await waitForJob(prisma, unknownId, ['dead'], 15_000)).toBe('dead');
    expect((await prisma.scheduledJob.findUnique({ where: { id: unknownId } }))!.lastError).toContain('handler 未注册');
  }, 40_000);

  it('P5 ③b cancel / pause / resume：暂停期绝不执行；取消后作废（残留 job 由状态守卫兜底）', async () => {
    // pause → 到点不执行 → resume → 执行完成
    const paused = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA)
      .send({ name: '暂停作业', handler: 'noop', type: 'delayed', runAt: Date.now() + 1000, organizationId: orgA }).expect(201);
    const pausedId = paused.body.data.job.id as string;
    jobIds.push(pausedId);
    await request(app.getHttpServer()).post(`/api/v1/scheduler/jobs/${pausedId}/pause`).set(XRW).set('Cookie', cookieA).expect(201);
    expect((await prisma.scheduledJob.findUnique({ where: { id: pausedId } }))!.status).toBe('paused');
    await new Promise((r) => setTimeout(r, 1500));
    expect((await prisma.scheduledJob.findUnique({ where: { id: pausedId } }))!.status).toBe('paused'); // 暂停期绝不执行
    await request(app.getHttpServer()).post(`/api/v1/scheduler/jobs/${pausedId}/resume`).set(XRW).set('Cookie', cookieA).expect(201);
    expect(await waitForJob(prisma, pausedId, ['completed'], 10_000)).toBe('completed');

    // cancel → 状态作废且不再执行（BullMQ job 已移除 + 行状态守卫双保险）
    const cancelled = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA)
      .send({ name: '取消作业', handler: 'noop', type: 'delayed', runAt: Date.now() + 1500, organizationId: orgA }).expect(201);
    const cancelledId = cancelled.body.data.job.id as string;
    jobIds.push(cancelledId);
    await request(app.getHttpServer()).post(`/api/v1/scheduler/jobs/${cancelledId}/cancel`).set(XRW).set('Cookie', cookieA).expect(201);
    await new Promise((r) => setTimeout(r, 2000));
    const after = await prisma.scheduledJob.findUnique({ where: { id: cancelledId } });
    expect(after!.status).toBe('cancelled');
    expect(after!.attempts).toBe(0); // attempts 只在认领时自增 → 从未被执行
  });

  it('P5 ③c recurring：repeatable job 注册（jobId=sched-rec-{id}）并可取消移除', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA)
      .send({ name: '周期作业', handler: 'noop', type: 'recurring', cron: '*/5 * * * *', organizationId: orgA }).expect(201);
    const jobId = res.body.data.job.id as string;
    jobIds.push(jobId);
    expect((await prisma.scheduledJob.findUnique({ where: { id: jobId } }))!.cron).toBe('*/5 * * * *');

    const repeatables = await queue.getRepeatableJobs();
    expect(repeatables.some((j) => j.name === `sched-rec-${jobId}`)).toBe(true);
    await request(app.getHttpServer()).post(`/api/v1/scheduler/jobs/${jobId}/cancel`).set(XRW).set('Cookie', cookieA).expect(201);
    expect((await queue.getRepeatableJobs()).some((j) => j.name === `sched-rec-${jobId}`)).toBe(false);
  });

  it('P5 ④ 事件平台：publish → 订阅消费 consumed；重复 eventId 幂等单行；失败 → dead → redeliver 恢复', async () => {
    const platform = app.get(EventPlatformService);
    let consumed = 0;
    await platform.subscribe({ name: 'p5-e2e-ok', eventTypes: ['p5.e2e.ok'], handler: () => { consumed += 1; } });

    const eventId = `p5-evt-ok-${Date.now()}`;
    eventIds.push(eventId);
    const published = await platform.publish({ eventId, eventType: 'p5.e2e.ok', organizationId: orgA, payload: { ok: true } });
    expect(published.created).toBe(true);
    expect(await waitForEvent(prisma, eventId, ['consumed'])).toBe('consumed');
    expect(consumed).toBe(1);

    // 重复 eventId：幂等（单行 + 不重复消费）
    const dup = await platform.publish({ eventId, eventType: 'p5.e2e.ok', organizationId: orgA, payload: { ok: false } });
    expect(dup.created).toBe(false);
    expect(dup.event.status).toBe('consumed');
    await new Promise((r) => setTimeout(r, 200));
    expect(consumed).toBe(1);
    expect(await prisma.eventEnvelope.count({ where: { eventId } })).toBe(1);

    // 消费失败 → 重试 → dead → redeliver 恢复
    let flaky = 0;
    await platform.subscribe({
      name: 'p5-e2e-flaky', eventTypes: ['p5.e2e.flaky'], maxAttempts: 3, backoffMs: 20,
      handler: () => { flaky += 1; if (flaky <= 3) throw new Error('flaky 消费者失败'); },
    });
    const flakyId = `p5-evt-flaky-${Date.now()}`;
    eventIds.push(flakyId);
    await platform.publish({ eventId: flakyId, eventType: 'p5.e2e.flaky', organizationId: orgA, payload: { n: 1 } });
    expect(await waitForEvent(prisma, flakyId, ['dead'])).toBe('dead');
    const deadRow = await prisma.eventEnvelope.findUnique({ where: { eventId: flakyId } });
    expect(deadRow!.attempts).toBe(3);
    expect(deadRow!.lastError).toContain('flaky 消费者失败');

    const redo = await request(app.getHttpServer()).post(`/api/v1/events/${flakyId}/redeliver`).set(XRW).set('Cookie', cookieA).expect(201);
    expect(redo.body.data.redelivered).toBe(true);
    expect(await waitForEvent(prisma, flakyId, ['consumed'])).toBe('consumed');
    expect(flaky).toBe(4); // 3 次失败 + 1 次成功——死信重投确实重新投递
    // 已消费 → 不可重投（409/400；绝不二次消费）
    await request(app.getHttpServer()).post(`/api/v1/events/${flakyId}/redeliver`).set(XRW).set('Cookie', cookieA).expect(400);

    // 列表查询（组织维度 + 状态过滤）
    const list = await request(app.getHttpServer()).get('/api/v1/events').set(XRW).set('Cookie', cookieA)
      .query({ eventType: 'p5.e2e.flaky', status: 'consumed' }).expect(200);
    const ids = (list.body.data.events as Array<{ eventId: string }>).map((e) => e.eventId);
    expect(ids).toContain(flakyId);
    expect((await prisma.eventEnvelope.findUnique({ where: { eventId } }))!.status).toBe('consumed');
  }, 30_000);

  it('P5 ⑤ 组织隔离：他人 org 列表 403；本组织列表只含自己的作业/事件；匿名 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieB)
      .query({ organizationId: orgA }).expect(403);
    await request(app.getHttpServer()).get('/api/v1/events').set(XRW).set('Cookie', cookieB)
      .query({ organizationId: orgA }).expect(403);
    await request(app.getHttpServer()).get('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA)
      .query({ organizationId: orgB }).expect(403);

    // B 看自己的（空列表，绝不含 A 的作业）
    const mineB = await request(app.getHttpServer()).get('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieB).expect(200);
    expect(mineB.body.data.jobs).toEqual([]);
    // A 的列表能看到自己的作业
    const mineA = await request(app.getHttpServer()).get('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookieA).expect(200);
    expect((mineA.body.data.jobs as Array<{ id: string }>).some((j) => j.id === jobIds[0])).toBe(true);

    // B 对 A 的作业做写操作 → 403（非成员）
    await request(app.getHttpServer()).post(`/api/v1/scheduler/jobs/${jobIds[0]}/cancel`).set(XRW).set('Cookie', cookieB).expect(403);
    // 匿名 → 401
    await request(app.getHttpServer()).get('/api/v1/scheduler/jobs').set(XRW).expect(401);
    await request(app.getHttpServer()).get('/api/v1/events').set(XRW).expect(401);
  });
});
