import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { SchedulerService } from '../src/modules/scheduler/scheduler.service';
import {
  METRIC_RETENTION_HANDLER, METRIC_RETENTION_CRON, METRIC_RETENTION_IDEMPOTENCY_KEY,
} from '../src/modules/scheduler/metric-retention.service';
import { EVENT_ARCHIVE_HANDLER, EVENT_ARCHIVE_IDEMPOTENCY_KEY } from '../src/modules/events/event-archive.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
/** Redis DB 隔离铁律（A8 = /28）；Pub/Sub 通道是实例全局的 → 本文件只做按唯一 id 收敛的断言 */
const REDIS_DB = 'redis://localhost:6379/28';
const DAY_MS = 24 * 60 * 60 * 1_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForJob(prisma: PrismaService, id: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'missing';
  while (Date.now() < deadline) {
    const row = await prisma.scheduledJob.findUnique({ where: { id } });
    last = row?.status ?? 'missing';
    if (row && ['completed', 'dead', 'cancelled'].includes(row.status)) return row.status;
    await sleep(100);
  }
  throw new Error(`ScheduledJob ${id} 未在 ${timeoutMs}ms 内到终态（当前 ${last}）`);
}

/**
 * M11-P8 e2e（真实 PostgreSQL + Redis /28 + BullMQ + 进程内 Worker）——只覆盖单测无法干净证明的事实：
 * ① D1-07 保留策略：经**真实 HTTP 建作业 → 真实 SchedulerProcessor → 真实 handler** 删除超期 MetricSample；
 *    窗口内的样本（同名）绝不误删；二次执行幂等（零额外删除）；每次执行留 `metric_sample_purge_count` 指标；
 * ② 维度2#10 归档活性：真实归档作业执行后留 `event_archive_count` 指标（平台级归属 null、无敏感字段）；
 * ③ D2-18 开通失败重试的**周期性探测**面：平台周期作业行缺失（模拟"启动时开通失败/行被硬删"）→
 *    无需重启进程，周期探测自动按同一幂等键重新开通（RECURRING_JOB_PROBE_MS 压到 1s 以在真实计时器上可观测；
 *    生产默认 15min，代码路径完全一致）。
 */
describe('M11-P8 MetricSample 保留策略 + 归档活性（e2e, 真实 Redis/BullMQ/Worker）', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  const jobIds: string[] = [];
  /** 本套件自建的指标名（清理与断言都按它收敛——绝不与其它套件的样本混同） */
  const metricName = `m11-p8-retention-${Date.now()}`;
  let purgeMetricT0 = 0;
  let archiveMetricT0 = 0;

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? REDIS_DB;
    // D2-18 周期性探测的观测窗口（生产默认 15min；此处压到 1s 以便在真实计时器上观测）
    process.env.RECURRING_JOB_PROBE_MS = '1000';

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

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    expect(login.status).toBe(201);
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');

    // 真实 Worker（消费 scheduler 队列 = 周期作业/保留策略的真实执行方）
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
    await sleep(1_000); // 就绪对齐：等阻塞连接与 handler 注册就位
  }, 60_000);

  afterAll(async () => {
    delete process.env.RECURRING_JOB_PROBE_MS;
    if (jobIds.length) await prisma.scheduledJob.deleteMany({ where: { id: { in: jobIds } } }).catch(() => undefined);
    await prisma.metricSample.deleteMany({ where: { name: metricName } }).catch(() => undefined);
    // 绝不删除平台周期作业行（platform:metric-sample-retention:v1 / platform:event-envelope-archive:v1）
    // ——它们是生产接线的事实，不是测试残留
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  // ================= D1-07：MetricSample 保留策略 =================

  it('D1-07 保留策略（真实 Worker）：超期同名样本被删、窗口内的绝不误删；二次执行幂等；留活性指标', async () => {
    const now = Date.now();
    // 同名 5 行：3 行超期（500 天前）+ 2 行窗口内（刚刚）——同名才能证明"删的是年龄而不是名字"。
    // 保留窗口取 400 天（> 本仓库/本库的最老数据），使候选集**只含本套件的 3 行**：真实删除面等价、
    // 且绝不误删共享开发库里其它套件仍可能读取的历史样本（provider_contract 等按绝对计数做增量断言）
    await prisma.metricSample.createMany({
      data: [
        ...[0, 1, 2].map((i) => ({ name: metricName, value: i, unit: 'count', sampledAt: new Date(now - 500 * DAY_MS) })),
        ...[0, 1].map((i) => ({ name: metricName, value: 100 + i, unit: 'count', sampledAt: new Date(now - i * 1_000) })),
      ],
    });
    expect(await prisma.metricSample.count({ where: { name: metricName } })).toBe(5);

    purgeMetricT0 = Date.now();
    // 经真实 HTTP + 真实 SchedulerProcessor 执行——与生产周期触发同一条路径（payload 覆盖保留窗口/批量）
    const created = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookie)
      .send({
        name: `m11-p8 保留策略 one-shot ${now}`, handler: METRIC_RETENTION_HANDLER, type: 'one-shot',
        payload: { retentionDays: 400, batchSize: 50, maxBatches: 50 },
      })
      .expect(201);
    const jobId = created.body.data.job.id as string;
    jobIds.push(jobId);
    expect(await waitForJob(prisma, jobId)).toBe('completed');

    const remaining = await prisma.metricSample.findMany({ where: { name: metricName }, orderBy: { sampledAt: 'asc' } });
    expect(remaining).toHaveLength(2); // 超期 3 行已删
    expect(remaining.every((r) => r.sampledAt.getTime() > now - DAY_MS)).toBe(true); // 窗口内样本原样保留
    expect(remaining.map((r) => r.value).sort()).toEqual([100, 101]); // 精确到具体行：删的是最旧的三行

    // 活性指标：每次执行一条（value = 删除行数；平台级归属 null；无敏感字段）
    const metric = await prisma.metricSample.findFirst({
      where: { name: 'metric_sample_purge_count', sampledAt: { gte: new Date(purgeMetricT0) } },
      orderBy: { sampledAt: 'desc' },
    });
    expect(metric).toBeTruthy();
    expect(metric!.unit).toBe('count');
    expect(metric!.organizationId).toBeNull();
    expect(metric!.value).toBe(3); // 本次真实删除数（候选集只含本套件的 3 行）
    expect(Object.keys((metric!.labels ?? {}) as Record<string, unknown>).sort())
      .toEqual(['batches', 'names', 'retentionDays', 'truncated']);

    // 幂等：二次执行 → 同名样本零变化（窗口内的仍是那两行），且活性指标如实记 0
    const t1 = Date.now();
    const second = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookie)
      .send({
        name: `m11-p8 保留策略 one-shot 二次 ${now}`, handler: METRIC_RETENTION_HANDLER, type: 'one-shot',
        payload: { retentionDays: 400, batchSize: 50, maxBatches: 50 },
      })
      .expect(201);
    const secondId = second.body.data.job.id as string;
    jobIds.push(secondId);
    expect(await waitForJob(prisma, secondId)).toBe('completed');
    expect(await prisma.metricSample.count({ where: { name: metricName } })).toBe(2);
    const secondMetric = await prisma.metricSample.findFirst({
      where: { name: 'metric_sample_purge_count', sampledAt: { gte: new Date(t1) } },
      orderBy: { sampledAt: 'desc' },
    });
    expect(secondMetric!.value).toBe(0); // 0 值也是活性信号（"在跑、没活儿"）
  }, 60_000);

  it('D1-07 生产接线：保留策略周期作业由调度模块启动即开通（handler/cron/幂等键；非测试触发）', async () => {
    const row = await prisma.scheduledJob.findFirst({ where: { idempotencyKey: METRIC_RETENTION_IDEMPOTENCY_KEY } });
    expect(row).toBeTruthy(); // SchedulerModule（API/Worker 两进程共享）onModuleInit 真实开通
    expect(row!.handler).toBe(METRIC_RETENTION_HANDLER);
    expect(row!.type).toBe('recurring');
    expect(row!.cron).toBe(METRIC_RETENTION_CRON);
    expect(row!.organizationId).toBeNull(); // 平台作业（非任何租户的作业）
  });

  // ================= 维度2#10：归档活性指标 =================

  it('维度2#10 归档活性：真实归档作业执行后留 event_archive_count 指标（平台归属、无敏感字段）', async () => {
    archiveMetricT0 = Date.now();
    const created = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookie)
      .send({ name: `m11-p8 归档 one-shot ${Date.now()}`, handler: EVENT_ARCHIVE_HANDLER, type: 'one-shot' })
      .expect(201);
    const jobId = created.body.data.job.id as string;
    jobIds.push(jobId);
    expect(await waitForJob(prisma, jobId)).toBe('completed');

    const metric = await prisma.metricSample.findFirst({
      where: { name: 'event_archive_count', sampledAt: { gte: new Date(archiveMetricT0) } },
      orderBy: { sampledAt: 'desc' },
    });
    expect(metric).toBeTruthy(); // 0 行也写（活性信号）
    expect(metric!.unit).toBe('count');
    expect(metric!.organizationId).toBeNull(); // 平台级事实，绝不借用调用者 trace 上下文的组织归属
    expect(metric!.value).toBeGreaterThanOrEqual(0);
    expect(Object.keys((metric!.labels ?? {}) as Record<string, unknown>).sort())
      .toEqual(['batches', 'retentionMs', 'scanned']); // 无 eventId/actor/payload 等敏感或行级字段
  }, 60_000);

  // ================= D2-18：开通失败（注册缺失）的周期性探测 =================

  it('D2-18 注册缺失 → 周期探测自动重新开通（无需重启进程；同一幂等键，绝不产生第二个作业）', async () => {
    const key = METRIC_RETENTION_IDEMPOTENCY_KEY;
    const before = await prisma.scheduledJob.findFirst({ where: { idempotencyKey: key } });
    expect(before).toBeTruthy();
    // 模拟"注册缺失"（启动时开通失败 / 行被硬删）：先注销 repeatable，再删行
    await app.get(SchedulerService).removeRepeatable(before!.id).catch(() => undefined);
    await prisma.scheduledJob.delete({ where: { id: before!.id } });
    expect(await prisma.scheduledJob.findFirst({ where: { idempotencyKey: key } })).toBeNull();

    // 周期探测（RECURRING_JOB_PROBE_MS=1000）→ 按同一幂等键自动重新开通
    const deadline = Date.now() + 20_000;
    let recreated = await prisma.scheduledJob.findFirst({ where: { idempotencyKey: key } });
    while (!recreated && Date.now() < deadline) {
      await sleep(200);
      recreated = await prisma.scheduledJob.findFirst({ where: { idempotencyKey: key } });
    }
    expect(recreated).toBeTruthy();
    expect(recreated!.id).not.toBe(before!.id); // 新行（旧行已删）
    expect(recreated!.handler).toBe(METRIC_RETENTION_HANDLER);
    expect(recreated!.type).toBe('recurring');
    expect(recreated!.cron).toBe(METRIC_RETENTION_CRON);
    expect(['scheduled', 'running']).toContain(recreated!.status);
    expect(await prisma.scheduledJob.count({ where: { idempotencyKey: key } })).toBe(1); // 绝不第二个作业
  }, 40_000);

  it('D2-18 既有平台作业（归档）保持开通且未被测试改动（接线事实留存）', async () => {
    const row = await prisma.scheduledJob.findFirst({ where: { idempotencyKey: EVENT_ARCHIVE_IDEMPOTENCY_KEY } });
    expect(row).toBeTruthy();
    expect(row!.handler).toBe(EVENT_ARCHIVE_HANDLER);
    expect(row!.type).toBe('recurring');
    expect(['scheduled', 'running']).toContain(row!.status);
  });
});
