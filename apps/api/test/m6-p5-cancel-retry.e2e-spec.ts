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

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

async function waitForStatus(prisma: PrismaService, runId: string, targets: string[], timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    last = run?.status ?? 'missing';
    if (run && targets.includes(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内到达 ${targets.join('/')}（当前 ${last}）`);
}

/**
 * M6-P5 e2e（真实 PostgreSQL + Redis/BullMQ + Worker）：
 * cancel（queued/running/waiting + 快速通道 + 任务取消意图 + 409/404）、
 * retry（血缘/attempt/幂等/usage 分离/409/404）、cancel vs 完成竞争的条件更新语义。
 */
describe('M6-P5 Cancellation + Retry (e2e, 真实 Queue + Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let cookieB: string;
  let userId = '';
  let agentId = '';
  let agentVersionId = '';
  let createdRunIds: string[] = [];
  let agentQueue: { pause(): Promise<void>; resume(): Promise<void>; close(): Promise<void> };

  beforeAll(async () => {
    process.env.MOCK_DELAY_MS = '50'; // 文本流 ~1.5s/回合：cancel-running 有确定性窗口（套件串行执行保证时序独占）
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
    const agent = await prisma.agent.findFirstOrThrow({ where: { slug: 'general-assistant' }, include: { activeVersion: true } });
    agentId = agent.id;
    agentVersionId = agent.activeVersion!.id;

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id;

    const userB = await prisma.user.create({ data: { email: `userb-p5-${Date.now()}@example.com`, passwordHash: 'unused-hash' } });
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);
    cookieB = `agent_access=${await jwt.signAsync({ sub: userB.id, role: 'user' })}`;

    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
    const { Queue } = await import('bullmq');
    agentQueue = new Queue('agent-run', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null } });
  });

  afterAll(async () => {
    await agentQueue?.resume().catch(() => undefined);
    await agentQueue?.close().catch(() => undefined);
    if (createdRunIds.length) {
      await prisma.generationTask.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.artifact.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.usageRecord.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.agentRun.deleteMany({ where: { id: { in: createdRunIds } } });
    }
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  it('P5-1 cancel queued：入队未领取 → cancelled；恢复队列后 claim 失败，绝不复活', async () => {
    await agentQueue.pause(); // run 保持 queued（确定性）
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    expect(await waitForStatus(prisma, runId, ['queued'])).toBe('queued');

    const cancelRes = await request(app.getHttpServer()).post(`/api/v1/agent-runs/${runId}/cancel`).set(XRW).set('Cookie', cookie)
      .expect(201);
    expect(cancelRes.body.data.status).toBe('cancelled');
    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status).toBe('cancelled');

    await agentQueue.resume();
    await new Promise((r) => setTimeout(r, 2000)); // 给 worker 消费机会
    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status).toBe('cancelled'); // 终态不可复活
  });

  it('P5-3 cancel running：快速通道 abort → cancelled（远快于 15s 心跳），usage 记 AGENT_CANCELLED', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好，请回复一段长文本' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    expect(await waitForStatus(prisma, runId, ['running'], 10_000)).toBe('running');

    const started = Date.now();
    const cancelRes = await request(app.getHttpServer()).post(`/api/v1/agent-runs/${runId}/cancel`).set(XRW).set('Cookie', cookie)
      .expect(201);
    expect(cancelRes.body.data.status).toBe('cancelled');
    expect(await waitForStatus(prisma, runId, ['cancelled'], 10_000)).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(10_000); // 快速通道（心跳 15s 兜底）

    // 取消绝不伪装 provider failure：已开始的回合记 AGENT_CANCELLED（未开始则无行——诚实零计费）。
    // （abort 落在 LLM 回合开始前/流中的时机差异由 engine 单测穷尽覆盖）
    const usage = await prisma.usageRecord.findMany({ where: { runId, kind: 'llm_chat' } });
    expect(usage.every((u) => u.status === 'success' || u.errorCode === 'AGENT_CANCELLED')).toBe(true);
    expect(usage.every((u) => !u.errorCode || u.errorCode !== 'PROVIDER_UNKNOWN')).toBe(true);
  });

  it('P5-5 cancel waiting：run cancelled + 等待任务取消意图（pending→cancelled）；任务终态绝不复活 run', async () => {
    const { Queue } = await import('bullmq');
    const imageQueue = new Queue('image', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null } });
    await imageQueue.pause();
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '画一张黑金配色主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    expect(await waitForStatus(prisma, runId, ['waiting'], 15_000)).toBe('waiting');
    const waiting = await prisma.agentRun.findUnique({ where: { id: runId } });
    expect(waiting?.waitingOnTaskId).toBeTruthy();

    await request(app.getHttpServer()).post(`/api/v1/agent-runs/${runId}/cancel`).set(XRW).set('Cookie', cookie).expect(201);
    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status).toBe('cancelled');
    // 取消意图：pending 任务 → cancelled（processing 不打断，其 hook 对已 cancelled run 为 no-op）
    expect((await prisma.generationTask.findUnique({ where: { id: waiting!.waitingOnTaskId! } }))?.status).toBe('cancelled');

    await imageQueue.resume(); // 任务消费者跳过已 cancelled 任务
    await new Promise((r) => setTimeout(r, 1500));
    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status).toBe('cancelled'); // 绝不复活
    await imageQueue.close();
  });

  it('P5-2 terminal 不可取消（409）；越权 404 防枚举', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 20_000)).toBe('completed');

    await request(app.getHttpServer()).post(`/api/v1/agent-runs/${runId}/cancel`).set(XRW).set('Cookie', cookie)
      .expect(409);
    if (cookieB) {
      await request(app.getHttpServer()).post(`/api/v1/agent-runs/${runId}/cancel`).set(XRW).set('Cookie', cookieB)
        .expect(404);
    }
  });

  it('P5-6/P5-7 retry：终态 run → 新 run（retryOfRunId 血缘 + attempt+1 + 同会话新 assistant 消息），旧 run 保持 terminal', async () => {
    // 构造终态 failed 的旧 run（带 conversation + transcript user 行）
    const conversation = await prisma.conversation.create({ data: { userId } });
    const oldRun = await prisma.agentRun.create({
      data: {
        userId, agentId, agentVersionId, conversationId: conversation.id,
        status: 'failed', errorCode: 'AGENT_MAX_STEPS', errorMessage: 'x', completedAt: new Date(),
        startedAt: new Date(), maxSteps: 8, attempt: 1, metadata: {},
      },
    });
    createdRunIds.push(oldRun.id);
    await prisma.agentRunMessage.create({ data: { runId: oldRun.id, sequence: 0, role: 'user', content: '你好，请回复' } });

    const retryRes = await request(app.getHttpServer()).post(`/api/v1/agent-runs/${oldRun.id}/retry`).set(XRW).set('Cookie', cookie)
      .expect(201);
    const newRunId = retryRes.body.data.runId as string;
    createdRunIds.push(newRunId);
    expect(retryRes.body.data).toMatchObject({ attempt: 2, retryOfRunId: oldRun.id });

    // 旧 run 永远 terminal
    expect((await prisma.agentRun.findUnique({ where: { id: oldRun.id } }))?.status).toBe('failed');
    // 新 run 执行完成
    expect(await waitForStatus(prisma, newRunId, ['completed', 'failed'], 25_000)).toBe('completed');
    const newRun = await prisma.agentRun.findUnique({ where: { id: newRunId }, include: { messages: { orderBy: { sequence: 'asc' } } } });
    expect(newRun?.retryOfRunId).toBe(oldRun.id);
    expect(newRun?.attempt).toBe(2);
    expect(newRun?.conversationId).toBe(conversation.id); // 同一会话
    expect(newRun?.messages[0]).toMatchObject({ role: 'user', content: '你好，请回复' }); // 用户消息复制（不新建 user Message）
    // 新 run 有独立 assistant Message（非旧消息复用）
    const assistantMessageId = (newRun!.metadata as { assistantMessageId: string }).assistantMessageId;
    expect(assistantMessageId).toBeTruthy();
    // P5-11 usage 分离：新 run 的 usage 全部归新 runId；旧 run 无新 usage
    expect(await prisma.usageRecord.count({ where: { runId: newRunId } })).toBeGreaterThan(0);
    expect(await prisma.usageRecord.count({ where: { runId: oldRun.id } })).toBe(0);
  });

  it('P5-9 retry 幂等：重复 POST retry → 同一 retry run（DB 部分唯一索引 + 查重），绝不产生第二个', async () => {
    const oldRun = await prisma.agentRun.create({
      data: { userId, agentId, agentVersionId, status: 'timeout', errorCode: 'AGENT_RUN_TIMEOUT', completedAt: new Date(), startedAt: new Date(), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(oldRun.id);
    await prisma.agentRunMessage.create({ data: { runId: oldRun.id, sequence: 0, role: 'user', content: '画一张黑金配色主图' } });

    const first = await request(app.getHttpServer()).post(`/api/v1/agent-runs/${oldRun.id}/retry`).set(XRW).set('Cookie', cookie)
      .expect(201);
    const second = await request(app.getHttpServer()).post(`/api/v1/agent-runs/${oldRun.id}/retry`).set(XRW).set('Cookie', cookie)
      .expect(201);
    const firstId = first.body.data.runId as string;
    expect(second.body.data.runId).toBe(firstId); // 幂等：同一 retry run
    createdRunIds.push(firstId);
    expect(await prisma.agentRun.count({ where: { retryOfRunId: oldRun.id } })).toBe(1);
  });

  it('P5-2/P5-8 retry 约束：非终态 409 RUN_NOT_RETRYABLE；越权 404', async () => {
    const activeRun = await prisma.agentRun.create({
      data: { userId, agentId, agentVersionId, status: 'running', startedAt: new Date(), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(activeRun.id);
    await request(app.getHttpServer()).post(`/api/v1/agent-runs/${activeRun.id}/retry`).set(XRW).set('Cookie', cookie)
      .expect(409);

    const doneRun = await prisma.agentRun.create({
      data: { userId, agentId, agentVersionId, status: 'failed', completedAt: new Date(), startedAt: new Date(), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(doneRun.id);
    if (cookieB) {
      await request(app.getHttpServer()).post(`/api/v1/agent-runs/${doneRun.id}/retry`).set(XRW).set('Cookie', cookieB)
        .expect(404);
    }
  });

  it('P5-6 retry 链：retry of retry → attempt 3（血缘链完整）', async () => {
    const root = await prisma.agentRun.create({
      data: { userId, agentId, agentVersionId, status: 'failed', completedAt: new Date(), startedAt: new Date(), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(root.id);
    await prisma.agentRunMessage.create({ data: { runId: root.id, sequence: 0, role: 'user', content: '你好' } });
    const r1 = await request(app.getHttpServer()).post(`/api/v1/agent-runs/${root.id}/retry`).set(XRW).set('Cookie', cookie).expect(201);
    const run1Id = r1.body.data.runId as string;
    createdRunIds.push(run1Id);
    await waitForStatus(prisma, run1Id, ['completed', 'failed'], 25_000);

    const r2 = await request(app.getHttpServer()).post(`/api/v1/agent-runs/${run1Id}/retry`).set(XRW).set('Cookie', cookie).expect(201);
    expect(r2.body.data).toMatchObject({ attempt: 3, retryOfRunId: run1Id });
    const run2Id = r2.body.data.runId as string;
    createdRunIds.push(run2Id);
    await waitForStatus(prisma, run2Id, ['completed', 'failed'], 25_000);
    const run2 = await prisma.agentRun.findUnique({ where: { id: run2Id } });
    expect(run2?.attempt).toBe(3);
    expect(run2?.retryOfRunId).toBe(run1Id);
  });
});
