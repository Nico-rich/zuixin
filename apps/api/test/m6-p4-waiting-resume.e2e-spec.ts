import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { AgentRunLeaseService } from '../src/core/agent-run-lease/agent-run-lease.service';
import { AgentRunResumeTrigger } from '../src/core/agent-run-resume/agent-run-resume-trigger.service';
import { AgentRunTimelineService } from '../src/modules/agent-runs/agent-run-timeline.service';

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
 * M6-P4 e2e（真实 PostgreSQL + Redis/BullMQ + Worker 上下文）：
 * 全链路 waiting→唤醒→resume；崩溃残留行恢复；任务失败回喂；deadline-while-waiting；重复唤醒幂等。
 * 确定性 waiting：暂停 image 队列（任务保持 pending）→ run 必然 waiting → 恢复队列 → 任务终态 hook 唤醒。
 */
describe('M6-P4 Waiting + Durable Resume (e2e, 真实 Queue + Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let userId = '';
  let agentId = '';
  let agentVersionId = '';
  let createdRunIds: string[] = [];
  let imageQueue: { pause(): Promise<void>; resume(): Promise<void>; close(): Promise<void> };

  beforeAll(async () => {
    process.env.MOCK_DELAY_MS = '0';
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

    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
    const { Queue } = await import('bullmq');
    imageQueue = new Queue('image', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null } });
  });

  afterAll(async () => {
    await imageQueue?.resume().catch(() => undefined);
    await imageQueue?.close().catch(() => undefined);
    if (createdRunIds.length) {
      // FK 顺序：Restrict 引用（GenerationTask/Artifact）→ 无 FK（usage）→ transcript → run（steps/toolCalls Cascade）
      await prisma.generationTask.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.artifact.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.usageRecord.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.agentRun.deleteMany({ where: { id: { in: createdRunIds } } });
    }
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  it('P4 全链路：POST → LLM 工具回合 → waiting（释放 worker/lease）→ 任务终态 hook 唤醒 → resume 补写任务结果 → final', async () => {
    await imageQueue.pause(); // 任务保持 pending → run 必然进入 waiting（确定性）
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '画一张黑金配色主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);

    // P4-5 waiting：workerId/leaseUntil/heartbeatAt 全释放，waitingOnTaskId 指向任务
    const waitingStatus = await waitForStatus(prisma, runId, ['waiting', 'completed'], 15_000);
    expect(waitingStatus).toBe('waiting');
    const waiting = await prisma.agentRun.findUnique({ where: { id: runId } });
    expect(waiting?.waitingOnTaskId).toBeTruthy();
    expect(waiting?.workerId).toBeNull();
    expect(waiting?.leaseUntil).toBeNull();
    expect(waiting?.heartbeatAt).toBeNull();
    // 此刻 tool 结果未写（由 resume 补写真实任务结果）
    const rowsWhileWaiting = await prisma.agentRunMessage.findMany({ where: { runId }, orderBy: { sequence: 'asc' } });
    expect(rowsWhileWaiting.some((r) => r.role === 'tool')).toBe(false);
    // Timeline 投影反映 waiting
    const timelineSvc = app.get(AgentRunTimelineService);
    const timelineWhileWaiting = await timelineSvc.build(userId, runId);
    expect(timelineWhileWaiting.items.some((i) => i.type === 'run.waiting')).toBe(true);

    await imageQueue.resume(); // 任务执行 → 终态 hook 唤醒（waiting→queued→claim→resume）
    const finalStatus = await waitForStatus(prisma, runId, ['completed', 'failed', 'timeout'], 30_000);
    expect(finalStatus).toBe('completed');

    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: { messages: { orderBy: { sequence: 'asc' } }, steps: { include: { toolCalls: true } } },
    });
    expect(run?.waitingOnTaskId).toBeNull(); // P4-7：resume 后清空
    expect(run?.workerId).toBeTruthy();       // claim 重新持有
    // resume 补写的 tool 结果 = 真实任务终态（非 stale pending）
    const toolRow = run!.messages.find((m) => m.role === 'tool');
    expect(toolRow).toBeTruthy();
    expect(toolRow!.content).toContain('"status":"completed"');
    // P4-12：LLM 用量 = 工具回合 + resume 后 final 回合，无重复
    const llmRounds = await prisma.usageRecord.count({ where: { runId, kind: 'llm_chat' } });
    expect(llmRounds).toBe(2);
    // Timeline：任务完成 + 终态（waiting 瞬态项已消失）
    const timeline = await timelineSvc.build(userId, runId);
    expect(timeline.items.some((i) => i.type === 'task.completed')).toBe(true);
    expect(timeline.items.some((i) => i.type === 'run.completed')).toBe(true);
  });

  it('P4-4 崩溃恢复：running ToolCall 残留行 → 同行重试（attempts+1）→ waiting → 唤醒 → resume（LLM decision 不重打，usage 不重复）', async () => {
    // 构造崩溃现场：transcript=[user, assistant(toolCalls)]（无 tool 结果）+ running ToolCall 行
    const run = await prisma.agentRun.create({
      data: { userId, agentId, agentVersionId, status: 'queued', startedAt: new Date(), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(run.id);
    const step = await prisma.agentRunStep.create({
      data: { runId: run.id, stepIndex: 0, type: 'tool_call', status: 'running' },
    });
    const callArgs = '{"prompt":"黑金主图"}';
    const idempotencyKey = createHash('sha256').update(`${run.id}:${step.id}:0:image.generate:${callArgs}`).digest('hex');
    await prisma.agentRunMessage.createMany({
      data: [
        { runId: run.id, sequence: 0, role: 'user', content: '画一张黑金配色主图' },
        { runId: run.id, sequence: 1, role: 'assistant', content: '', toolCalls: [{ id: 'call_fake_1', name: 'image.generate', arguments: callArgs }] as never },
      ],
    });
    await prisma.toolCall.create({
      data: { runStepId: step.id, toolName: 'image.generate', idempotencyKey, input: JSON.parse(callArgs) as never, status: 'running' },
    });

    await imageQueue.pause(); // 重试执行创建的任务保持 pending → 再次确定性 waiting
    const { Queue } = await import('bullmq');
    const agentQueue = new Queue('agent-run', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null } });
    await agentQueue.add('execute', { runId: run.id }, { attempts: 2, removeOnComplete: true, removeOnFail: { count: 500 } });

    const waitingStatus = await waitForStatus(prisma, run.id, ['waiting', 'completed'], 15_000);
    expect(waitingStatus).toBe('waiting'); // 残留行重试执行 → 新任务 pending → waiting
    // P4-4：同一行重试（attempts+1），未新建 ToolCall 行
    const calls = await prisma.toolCall.findMany({ where: { runStepId: step.id } });
    expect(calls).toHaveLength(1);
    expect(calls[0].attempts).toBe(2);

    await imageQueue.resume();
    const finalStatus = await waitForStatus(prisma, run.id, ['completed', 'failed', 'timeout'], 30_000);
    expect(finalStatus).toBe('completed');
    // P4-3 + P4-12：被恢复回合绝不重打 LLM——usage 只有 resume 后 final 回合 1 条
    expect(await prisma.usageRecord.count({ where: { runId: run.id, kind: 'llm_chat' } })).toBe(1);
    // 任务归属正确（重试执行的 GenerationTask 挂本 run + 幂等键）
    const tasks = await prisma.generationTask.findMany({ where: { runId: run.id } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].idempotencyKey).toBe(idempotencyKey);
    await agentQueue.close();
  }, 60_000);

  it('P4-9 任务失败：resume 补写失败结果 → 回喂模型 → LLM 决定（run 不直接 failed）', async () => {
    const run = await prisma.agentRun.create({
      data: { userId, agentId, agentVersionId, status: 'queued', startedAt: new Date(), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(run.id);
    const step = await prisma.agentRunStep.create({
      data: { runId: run.id, stepIndex: 0, type: 'tool_call', status: 'running' },
    });
    const callArgs = '{"prompt":"黑金主图"}';
    const idempotencyKey = createHash('sha256').update(`${run.id}:${step.id}:0:image.generate:${callArgs}`).digest('hex');
    await prisma.agentRunMessage.createMany({
      data: [
        { runId: run.id, sequence: 0, role: 'user', content: '画一张黑金配色主图' },
        { runId: run.id, sequence: 1, role: 'assistant', content: '', toolCalls: [{ id: 'call_fake_2', name: 'image.generate', arguments: callArgs }] as never },
      ],
    });
    const toolCall = await prisma.toolCall.create({
      data: { runStepId: step.id, toolName: 'image.generate', idempotencyKey, input: JSON.parse(callArgs) as never, status: 'completed', output: { taskId: 'task-failed-1', status: 'pending' } as never, completedAt: new Date() },
    });
    // 任务已失败（provider 失败被 media 侧终态）——hook 未触发（无 waiting），由 resume 读取任务事实
    await prisma.generationTask.create({
      data: {
        id: 'task-failed-1', userId, type: 'image', status: 'failed',
        statusMessage: '任务超时', errorCode: 'MEDIA_TASK_TIMEOUT', errorMessage: '任务超时',
        input: JSON.parse(callArgs) as never, runId: run.id, toolCallId: toolCall.id, completedAt: new Date(),
      },
    });

    const { Queue } = await import('bullmq');
    const agentQueue = new Queue('agent-run', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null } });
    await agentQueue.add('execute', { runId: run.id }, { attempts: 2, removeOnComplete: true, removeOnFail: { count: 500 } });

    const finalStatus = await waitForStatus(prisma, run.id, ['completed', 'failed', 'timeout'], 20_000);
    expect(finalStatus).toBe('completed'); // P4-9：任务失败不直接 failed，LLM 决定
    const rows = await prisma.agentRunMessage.findMany({ where: { runId: run.id }, orderBy: { sequence: 'asc' } });
    const toolRow = rows.find((m) => m.role === 'tool');
    expect(toolRow?.content).toContain('"status":"failed"'); // 失败结果回喂
    expect(toolRow?.content).toContain('任务超时');
    expect(await prisma.usageRecord.count({ where: { runId: run.id, kind: 'llm_chat' } })).toBe(1);
    await agentQueue.close();
  });

  it('P4-10 deadline-while-waiting：任务终态到达但 deadline 已过 → timeout，绝不复活', async () => {
    const run = await prisma.agentRun.create({
      data: { userId, agentId, agentVersionId, status: 'waiting', startedAt: new Date(Date.now() - 50 * 60_000), maxSteps: 8, metadata: {} },
    });
    const task = await prisma.generationTask.create({
      data: { userId, type: 'image', status: 'completed', statusMessage: '完成', input: { prompt: 'x' } as never, runId: run.id, completedAt: new Date() },
    });
    await prisma.agentRun.update({ where: { id: run.id }, data: { waitingOnTaskId: task.id } });
    createdRunIds.push(run.id);

    // 直连 hook：deadline 已过 → timeout，不唤醒
    const trigger = worker.get(AgentRunResumeTrigger);
    const woken = await trigger.wakeWaitingRun(run.id, task.id);
    expect(woken.woken).toBe(false);
    expect((await prisma.agentRun.findUnique({ where: { id: run.id } }))?.status).toBe('timeout');

    // recoverStale 兜底同样处理 waiting（条件更新不复活终态）
    const run2 = await prisma.agentRun.create({
      data: { userId, agentId, agentVersionId, status: 'waiting', waitingOnTaskId: task.id, startedAt: new Date(Date.now() - 50 * 60_000), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(run2.id);
    const lease = worker.get(AgentRunLeaseService);
    const res = await lease.recoverStale();
    expect(res.timedOut).toBeGreaterThanOrEqual(1);
    expect((await prisma.agentRun.findUnique({ where: { id: run2.id } }))?.status).toBe('timeout');
  });

  it('P4-6/P4-8 重复唤醒：hook ×2 + recoverStale 兜底 → 条件更新去重，只执行一次（usage 单回合）', async () => {
    const run = await prisma.agentRun.create({
      data: { userId, agentId, agentVersionId, status: 'waiting', startedAt: new Date(), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(run.id);
    const step = await prisma.agentRunStep.create({
      data: { runId: run.id, stepIndex: 0, type: 'tool_call', status: 'running' },
    });
    const callArgs = '{"prompt":"黑金主图"}';
    const idempotencyKey = createHash('sha256').update(`${run.id}:${step.id}:0:image.generate:${callArgs}`).digest('hex');
    await prisma.agentRunMessage.createMany({
      data: [
        { runId: run.id, sequence: 0, role: 'user', content: '画一张黑金配色主图' },
        { runId: run.id, sequence: 1, role: 'assistant', content: '', toolCalls: [{ id: 'call_fake_3', name: 'image.generate', arguments: callArgs }] as never },
      ],
    });
    const toolCall = await prisma.toolCall.create({
      data: { runStepId: step.id, toolName: 'image.generate', idempotencyKey, input: JSON.parse(callArgs) as never, status: 'completed', output: { taskId: 'task-done-1', status: 'pending' } as never, completedAt: new Date() },
    });
    const task = await prisma.generationTask.create({
      data: {
        id: 'task-done-1', userId, type: 'image', status: 'completed', statusMessage: '完成',
        input: JSON.parse(callArgs) as never, output: { attachments: [] } as never,
        runId: run.id, toolCallId: toolCall.id, completedAt: new Date(),
      },
    });
    await prisma.agentRun.update({ where: { id: run.id }, data: { waitingOnTaskId: task.id } });

    const trigger = worker.get(AgentRunResumeTrigger);
    const first = await trigger.wakeWaitingRun(run.id, task.id);
    expect(first.woken).toBe(true);
    const second = await trigger.wakeWaitingRun(run.id, task.id);
    expect(second.woken).toBe(false); // 已 queued，条件更新去重
    const lease = worker.get(AgentRunLeaseService);
    await lease.recoverStale(); // 兜底通道：queued 且未超期 → 不重复入队

    const finalStatus = await waitForStatus(prisma, run.id, ['completed', 'failed', 'timeout'], 20_000);
    expect(finalStatus).toBe('completed');
    // 只执行一次：LLM 单回合（resume 后 final），completed 行复用零重复执行
    expect(await prisma.usageRecord.count({ where: { runId: run.id, kind: 'llm_chat' } })).toBe(1);
    expect(await prisma.generationTask.count({ where: { runId: run.id } })).toBe(1);
    // 越权矩阵：B 用户不可唤醒（wakeWaitingRun 只按 DB 状态，不涉身份——但 run 状态机封锁终态复活）
    const third = await trigger.wakeWaitingRun(run.id, task.id);
    expect(third.woken).toBe(false); // 已终态，绝不复活
  });
});
