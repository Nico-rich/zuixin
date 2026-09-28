import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
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
import { SchedulerService } from '../src/modules/scheduler/scheduler.service';
import { LLMManagerService } from '../src/providers/llm/llm-manager.service';
import {
  EVENT_ARCHIVE_HANDLER, EVENT_ARCHIVE_CRON, EVENT_ARCHIVE_IDEMPOTENCY_KEY,
} from '../src/modules/events/event-archive.service';
import { AGENT_RUN_QUEUE } from '../src/core/queue/queue.module';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
/** Redis DB 隔离铁律（A10 = /29）：keyspace 隔离对队列成立（pub/sub 是实例全局的，本文件不做通道级负向断言） */
const REDIS_DB = 'redis://localhost:6379/29';
const REDIS = () => ({ url: process.env.REDIS_URL ?? REDIS_DB, maxRetriesPerRequest: null });
/** seed 的 mock LLM 替身（adapter=mock，逐字符延迟受 MOCK_DELAY_MS 控制）——钉死模型后回合必走该适配器 */
const MOCK_ECHO_MODEL_ID = 'seed-model-mock-echo';
const DAY_MS = 24 * 60 * 60 * 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForStatus(prisma: PrismaService, runId: string, targets: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'missing';
  while (Date.now() < deadline) {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    last = run?.status ?? 'missing';
    if (run && targets.includes(run.status)) return run.status;
    await sleep(100);
  }
  throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内到达 ${targets.join('/')}（当前 ${last}）`);
}

/** 等调度作业到终态（completed/dead/cancelled）——事实源是 ScheduledJob 行 */
async function waitForJob(prisma: PrismaService, jobId: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'missing';
  while (Date.now() < deadline) {
    const row = await prisma.scheduledJob.findUnique({ where: { id: jobId } });
    last = row?.status ?? 'missing';
    if (row && ['completed', 'dead', 'cancelled'].includes(row.status)) return row.status;
    await sleep(100);
  }
  throw new Error(`scheduledJob ${jobId} 未在 ${timeoutMs}ms 内到终态（当前 ${last}）`);
}

/**
 * M10-P10 运行时可靠性 e2e（真实 PostgreSQL + Redis DB/29 + BullMQ + 进程内 Worker）。
 * 只覆盖"单测无法干净证明"的真进程/真 DB 事实：
 * ① X-02 单回合 watchdog：把 AgentVersion **钉死到 mock 适配器**（MOCK_DELAY_MS=1500 逐字符延迟，
 *    远超回合上限 200ms）→ 真实 worker 上的卡顿回合必须被回合级闸门中断并归因 **PROVIDER_TIMEOUT**
 *    （且总耗时 ≈ 3 次尝试，而非逐字符跑满 80s+ 或撞 run deadline → timeout/AGENT_RUN_TIMEOUT）；
 * ② M9-11 归档：经**真实 Scheduler**（HTTP 建 one-shot 作业 → 真实 SchedulerProcessor → 真实 handler）
 *    把超期 published 收敛为 consumed；保留窗口内的行与 dead 行绝不被触碰；不删行；二次运行幂等；
 * ③ M9-11 生产接线：worker 启动即开通平台周期归档作业（无任何测试代码触发）——"只有测试调用"的反面证据；
 * ④ X-27/PR-3 背压：队列**暂停**期间（waiting=active=0 而 paused>0）按真实积压拒绝 429；撤压后放行。
 * X-01（in-flight 集合）/X-04（tool 默认重试）/X-05（订阅回收）的判别性证据在单测（旧实现下必然失败）；
 * e2e 无法干净区分（心跳/兜底路径会掩盖差异）——不在本文件重复造弱断言。
 */
describe('Pre-M10 运行时可靠性 (e2e, 真实 Queue + Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let userId = '';
  let watchdogAgentId = '';
  const runIds: string[] = [];
  const jobIds: string[] = [];
  const eventIds: string[] = [];

  beforeAll(async () => {
    // X-02 实验条件：单回合上限 200ms（默认 60s）+ mock 流每字符 1.5s（≫ 上限）+ 退避近零 ⇒
    // 真实计时器上的确定性：每次尝试在"下一个字符到达"前即被判超时（不依赖假定时器）
    process.env.REDIS_URL = process.env.REDIS_URL ?? REDIS_DB;
    process.env.MOCK_DELAY_MS = '1500';
    process.env.AGENT_RUN_LLM_TURN_MS = '200';
    process.env.LLM_RETRY_BACKOFF_MS = '50,100';

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
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id;

    // 钉死模型的 Agent：versions.modelId 显式指定 → 路由不参与（走 llmManager.resolve 的直达路径），
    // 回合必落在 mock 适配器上（逐字符 1.5s）——这是 X-02 可判别的关键
    const agent = await prisma.agent.create({
      data: {
        slug: `prem10-watchdog-${Date.now()}`, name: 'prem10 watchdog agent', enabled: true, builtin: false, kind: 'custom', scope: 'system',
        versions: {
          create: {
            version: 1, status: 'published', systemPrompt: '你是稳定性验证用 Agent。',
            temperature: 0.7, modelId: MOCK_ECHO_MODEL_ID, tools: [] as never,
            config: { maxSteps: 2 } as never,
          },
        },
      },
      include: { versions: true },
    });
    watchdogAgentId = agent.id;
    await prisma.agent.update({ where: { id: agent.id }, data: { activeVersionId: agent.versions[0].id } });

    // 真实 Worker 进程（消费 agent-run / scheduler 队列；其 LLM 适配器在启动时按当时 env 构建）
    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
    // 就绪对齐：等两个 worker 的阻塞连接就位（避免首个 job 与订阅建立竞态）
    await sleep(1_000);
  }, 60_000);

  afterAll(async () => {
    if (runIds.length) {
      await prisma.generationTask.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
      await prisma.artifact.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
      await prisma.usageRecord.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
      await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => undefined);
    }
    if (jobIds.length) await prisma.scheduledJob.deleteMany({ where: { id: { in: jobIds } } }).catch(() => undefined);
    if (eventIds.length) await prisma.eventEnvelope.deleteMany({ where: { eventId: { in: eventIds } } }).catch(() => undefined);
    if (watchdogAgentId) await prisma.agent.delete({ where: { id: watchdogAgentId } }).catch(() => undefined);
    // 绝不删除平台周期作业行（platform:event-envelope-archive:v1）——它是生产接线的事实，不是测试残留
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  // ================= X-02：LLM 单回合 watchdog =================

  it('X-02 单回合 watchdog（真实 worker + 真实适配器）：卡顿回合被中断并归因 PROVIDER_TIMEOUT', async () => {
    const t0 = Date.now();
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: watchdogAgentId, message: '你好，请自我介绍一下' }).expect(201);
    const runId = res.body.data.runId as string;
    runIds.push(runId);

    // 无 watchdog 时：~55 字符 × 1.5s ≈ 82s（要么拖到 run deadline → timeout/AGENT_RUN_TIMEOUT，要么长时间占满 worker）
    expect(await waitForStatus(prisma, runId, ['failed', 'timeout'], 45_000)).toBe('failed');
    const elapsed = Date.now() - t0;
    const row = await prisma.agentRun.findUnique({ where: { id: runId } });
    expect(row!.errorCode).toBe('PROVIDER_TIMEOUT'); // 回合超时归因（可重试语义）——绝不是 AGENT_RUN_TIMEOUT
    expect(elapsed).toBeLessThan(30_000); // 3 次尝试 × ~1.5s + 近零退避 ⇒ 回合级闸门真实生效
    // 可能已计费的回合必须可观测（durable）：failed + PROVIDER_TIMEOUT 的 usage 行
    const usage = await prisma.usageRecord.findFirst({ where: { runId, kind: 'llm_chat' } });
    expect(usage?.status).toBe('failed');
    expect(usage?.errorCode).toBe('PROVIDER_TIMEOUT');
  }, 60_000);

  // ================= M9-11：EventEnvelope 归档 =================

  it('M9-11 归档（真实 Scheduler）：超期 published → consumed；窗口内/死信不动；不删行；二次运行幂等', async () => {
    const now = Date.now();
    const suffix = `prem10-archive-${now}`;
    const oldId = `${suffix}-old`;
    const freshId = `${suffix}-fresh`;
    const deadId = `${suffix}-dead`;
    eventIds.push(oldId, freshId, deadId);
    await prisma.eventEnvelope.createMany({
      data: [
        // 超过保留窗口（默认 7 天）→ 归档候选
        { eventId: oldId, eventType: 'prem10.archive.old', occurredAt: new Date(now - 10 * DAY_MS), status: 'published' },
        // 窗口内 → 绝不归档（保留窗口语义：新事件不因归档丢失待投递语义）
        { eventId: freshId, eventType: 'prem10.archive.fresh', occurredAt: new Date(now - 60_000), status: 'published' },
        // 死信（消费失败待人工）→ 归档绝不掩盖未决状态
        { eventId: deadId, eventType: 'prem10.archive.dead', occurredAt: new Date(now - 10 * DAY_MS), status: 'dead', attempts: 3, lastError: 'prem10 故意死信' },
      ],
    });

    // 经真实 HTTP + 真实 SchedulerProcessor（worker 进程内）执行——与生产周期触发同一条路径
    const created = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookie)
      .send({ name: `prem10 归档 one-shot ${now}`, handler: EVENT_ARCHIVE_HANDLER, type: 'one-shot' }).expect(201);
    const jobId = created.body.data.job.id as string;
    jobIds.push(jobId);
    expect(await waitForJob(prisma, jobId)).toBe('completed');

    const oldRow = await prisma.eventEnvelope.findUnique({ where: { eventId: oldId } });
    expect(oldRow!.status).toBe('consumed');
    expect(oldRow!.consumedAt).toBeInstanceOf(Date);
    expect(oldRow!.lastError).toBeNull();
    // 事实源完整保留（归档 = 状态收敛，绝不物理删除）
    expect(await prisma.eventEnvelope.count({ where: { eventId: oldId } })).toBe(1);
    expect((await prisma.eventEnvelope.findUnique({ where: { eventId: freshId } }))!.status).toBe('published');
    const deadRow = await prisma.eventEnvelope.findUnique({ where: { eventId: deadId } });
    expect(deadRow!.status).toBe('dead');
    expect(deadRow!.consumedAt).toBeNull();
    expect(deadRow!.lastError).toContain('prem10 故意死信');

    // 幂等：第二次执行 → 已 consumed 的行不再是候选（consumedAt 不变，绝不重复处理）
    const consumedAtFirst = oldRow!.consumedAt!.getTime();
    const second = await request(app.getHttpServer()).post('/api/v1/scheduler/jobs').set(XRW).set('Cookie', cookie)
      .send({ name: `prem10 归档 one-shot 二次 ${now}`, handler: EVENT_ARCHIVE_HANDLER, type: 'one-shot' }).expect(201);
    const secondId = second.body.data.job.id as string;
    jobIds.push(secondId);
    expect(await waitForJob(prisma, secondId)).toBe('completed');
    expect((await prisma.eventEnvelope.findUnique({ where: { eventId: oldId } }))!.consumedAt!.getTime()).toBe(consumedAtFirst);
    expect((await prisma.eventEnvelope.findUnique({ where: { eventId: freshId } }))!.status).toBe('published');
  }, 90_000);

  it('M9-11 生产接线：worker 启动即开通平台周期归档作业（非测试触发），重复开通幂等', async () => {
    const row = await prisma.scheduledJob.findFirst({ where: { idempotencyKey: EVENT_ARCHIVE_IDEMPOTENCY_KEY } });
    expect(row).toBeTruthy(); // worker 启动时 EventArchiveService.onModuleInit 真实开通
    expect(row!.handler).toBe(EVENT_ARCHIVE_HANDLER);
    expect(row!.type).toBe('recurring');
    expect(row!.cron).toBe(EVENT_ARCHIVE_CRON);
    expect(['scheduled', 'running']).toContain(row!.status);
    // 幂等：同键再开通 → 同一行（绝不产生第二个周期作业 / 不重复入队）
    const again = await app.get(SchedulerService).schedule({
      ownerUserId: userId, organizationId: null,
      name: 'EventEnvelope 归档（published → consumed）', handler: EVENT_ARCHIVE_HANDLER,
      type: 'recurring', cron: EVENT_ARCHIVE_CRON, idempotencyKey: EVENT_ARCHIVE_IDEMPOTENCY_KEY,
    });
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(row!.id);
  });

  // ================= X-27 / PR-3：背压计入 paused =================

  it('X-27/PR-3 背压计入 paused：队列暂停期间（waiting=active=0）仍按真实积压拒绝 429；撤压放行', async () => {
    // 本用例要跑真实 LLM：恢复近零延迟 + 放宽回合上限，并让 worker 按新 env 重建适配器
    process.env.MOCK_DELAY_MS = '0';
    process.env.AGENT_RUN_LLM_TURN_MS = '60000';
    await worker.get(LLMManagerService).refresh();

    const queue = new Queue(AGENT_RUN_QUEUE, { connection: REDIS() });
    const prevDepth = process.env.AGENT_RUN_QUEUE_MAX_DEPTH;
    try {
      await queue.pause();
      let counts = await queue.getJobCounts('waiting', 'active', 'paused');
      // 暂停期间的投递整体落进 paused 集合（BullMQ 语义）：只数 waiting+active 的老口径读到 depth=0
      for (let attempt = 0; attempt < 20 && (counts.paused ?? 0) < 2; attempt++) {
        await queue.addBulk(Array.from({ length: 5 }, () => (
          { name: 'prem10-backpressure-filler', data: {}, opts: { removeOnComplete: true } }
        )));
        counts = await queue.getJobCounts('waiting', 'active', 'paused');
      }
      expect(counts.waiting ?? 0).toBe(0); // 老口径的全部输入均为 0 —— 新口径必须靠 paused 才能看见积压
      expect(counts.active ?? 0).toBe(0);
      expect(counts.paused ?? 0).toBeGreaterThanOrEqual(2);

      process.env.AGENT_RUN_QUEUE_MAX_DEPTH = '1';
      const blocked = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
        .send({ message: '你好' }).expect(429);
      expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED');
      expect(blocked.body.error.message).toMatch(/积压 \d+\/1，/); // depth = **含 paused** 的真实计数
    } finally {
      // 撤压 + 清占位 job + 还原水位（绝不给共享队列与后续用例留下污染状态）
      const leftovers = await queue.getJobs(['paused', 'waiting'], 0, -1);
      for (const job of leftovers) await job.remove().catch(() => undefined);
      await queue.resume();
      if (prevDepth === undefined) delete process.env.AGENT_RUN_QUEUE_MAX_DEPTH;
      else process.env.AGENT_RUN_QUEUE_MAX_DEPTH = prevDepth;
      // 排空对齐：确认恢复消费（waiting/active/paused 全 0）再做放行断言
      const drainDeadline = Date.now() + 15_000;
      for (;;) {
        const c = await queue.getJobCounts('waiting', 'active', 'paused');
        if ((c.waiting ?? 0) + (c.active ?? 0) + (c.paused ?? 0) === 0) break;
        if (Date.now() > drainDeadline) break;
        await sleep(200);
      }
      await queue.close();
    }

    // 撤压后真实放行（队列恢复消费 → run 正常终态）
    const allowed = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' }).expect(201);
    const allowedId = allowed.body.data.runId as string;
    runIds.push(allowedId);
    expect(await waitForStatus(prisma, allowedId, ['completed', 'failed'], 60_000)).toBe('completed');
  }, 120_000);
});
