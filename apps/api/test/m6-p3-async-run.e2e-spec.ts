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
import { AgentRunLeaseService } from '../src/core/agent-run-lease/agent-run-lease.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

/** 轮询等待 run 终态 */
async function waitForTerminal(prisma: PrismaService, runId: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (run && ['completed', 'failed', 'cancelled', 'timeout'].includes(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内终态`);
}

/**
 * M6-P3 真实 Queue → Worker → AgentRun 全链路 e2e：
 * API 应用（POST /agent-runs 生产者）+ 同进程 Worker 上下文（agent-run 队列真实消费）。
 * 覆盖：异步创建即返回、worker claim→engine→终态、transcript/消息/usage 落库、
 * duplicate job 幂等、越权 404、lease claim 竞争/stale takeover、recoverStale 双分支。
 */
describe('M6-P3 异步 AgentRun (e2e, 真实 Queue + Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let cookieB: string;
  let userId = '';
  let agentId = '';
  let createdRunIds: string[] = [];

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
    agentId = (await prisma.agent.findFirstOrThrow({ where: { slug: 'general-assistant' } })).id;

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id;

    // 用户 B（越权矩阵）：prisma 建行 + 应用内 JwtService 签 token（无注册端点，直接构造登录态）
    const userB = await prisma.user.create({
      data: { email: `userb-${Date.now()}@example.com`, passwordHash: 'unused-hash' },
    });
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);
    cookieB = `agent_access=${await jwt.signAsync({ sub: userB.id, role: 'user' })}`;

    // 真实 Worker 上下文（同进程消费 agent-run 队列；与 worker.ts 同款启动方式）
    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  });

  afterAll(async () => {
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

  it('POST /agent-runs → 201 立即返回 runId(queued) → Worker 真实执行 → completed + transcript/消息/usage 全落库', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '画一张黑金配色主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    expect(res.body.data.status).toBe('queued');
    // HTTP 立即返回：此刻 run 尚未完成（worker 异步执行）
    const immediate = await prisma.agentRun.findUnique({ where: { id: runId } });
    expect(['queued', 'running', 'completed']).toContain(immediate?.status);

    const finalStatus = await waitForTerminal(prisma, runId);
    expect(finalStatus).toBe('completed');

    // M7-P9 确定性修复：messages 按 sequence 排序（无 orderBy 时物理顺序不可保证——全量串行套件下偶发 flake）
    const run = await prisma.agentRun.findUnique({ where: { id: runId }, include: { steps: { include: { toolCalls: true } }, messages: { orderBy: { sequence: 'asc' } } } });
    expect(run?.workerId).toBeTruthy(); // 由 worker claim
    expect(run?.steps.some((s) => s.type === 'tool_call' && s.toolCalls.some((t) => t.toolName === 'image.generate'))).toBe(true);
    expect(run?.steps.some((s) => s.type === 'final')).toBe(true);
    // transcript：user(API seed) + system + assistant(toolCalls) + tool + final assistant
    const roles = run!.messages.map((m) => m.role);
    expect(roles[0]).toBe('user');
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool');
    expect(run!.messages.find((m) => m.role === 'assistant' && m.toolCalls != null)).toBeTruthy();
    // assistant Message 由 driver 落库 completed + content——run 终态翻转后写入（按设计的最终一致，
    // 全量负载下窗口拉宽，必须轮询而非即时断言）
    const metadata = run!.metadata as { assistantMessageId: string };
    const msgDeadline = Date.now() + 10_000;
    let assistant: { status: string; content: string } | null = null;
    while (Date.now() < msgDeadline) {
      assistant = await prisma.message.findUnique({ where: { id: metadata.assistantMessageId }, select: { status: true, content: true } });
      if (assistant?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(assistant?.status).toBe('completed');
    expect(assistant?.content.length).toBeGreaterThan(0);
    // usage：LLM 回合 + 媒体任务归因 runId
    const usage = await prisma.usageRecord.findMany({ where: { runId } });
    expect(usage.some((u) => u.kind === 'llm_chat')).toBe(true);
    // 身份正确性：run 归属 JWT 用户（而非 payload）
    expect(run?.userId).toBe(userId);
  });

  it('duplicate job：同 runId 重复入队 → 第二个 job claim 失败退出，绝不重复执行（usage 不翻倍）', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    await waitForTerminal(prisma, runId);
    const usageBefore = await prisma.usageRecord.count({ where: { runId } });

    // 终态后重复入队：claim 必然失败（terminal 不可 claim）→ 无新 usage
    const { Queue } = await import('bullmq');
    const queue = new Queue('agent-run', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null } });
    await queue.add('execute', { runId }, { attempts: 2, removeOnComplete: true, removeOnFail: { count: 500 } });
    await new Promise((r) => setTimeout(r, 1500));
    await queue.close();

    const usageAfter = await prisma.usageRecord.count({ where: { runId } });
    expect(usageAfter).toBe(usageBefore);
  });

  it('越权：他人用户读 run → 404（防枚举）；POST 不接受身份字段', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '测试越权' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);

    // 匿名/未登录 401；B 用户 cookie 读 A 的 run → 404
    await request(app.getHttpServer()).get(`/api/v1/agent-runs/${runId}`).set(XRW).expect(401);
    if (cookieB) {
      await request(app.getHttpServer()).get(`/api/v1/agent-runs/${runId}`).set(XRW).set('Cookie', cookieB).expect(404);
    }
    // run 归属始终是 A（JWT 注入，payload 无法指定）
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    expect(run?.userId).toBe(userId);
  });

  it('lease：首次 claim 成功 / 第二 worker claim 失败 / stale 过期后可接管 / 旧 worker renew count=0（fencing）', async () => {
    const lease = worker.get(AgentRunLeaseService);
    const run = await prisma.agentRun.create({
      data: { userId, agentId, status: 'queued', startedAt: new Date() },
    });
    createdRunIds.push(run.id);

    const first = await lease.claim(run.id, 'worker-A', 60_000);
    expect(first.acquired).toBe(true);
    const second = await lease.claim(run.id, 'worker-B', 60_000);
    expect(second.acquired).toBe(false); // 同一 run 同时只有一个 worker

    // 模拟 lease 过期（worker A 失联）→ B 接管成功（stale takeover）
    await prisma.agentRun.update({ where: { id: run.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    const takeover = await lease.claim(run.id, 'worker-B', 60_000);
    expect(takeover.acquired).toBe(true);

    // 旧 worker renew → count=0（fencing：必须停止执行）
    const fenced = await lease.renew(run.id, 'worker-A', 60_000);
    expect(fenced.count).toBe(0);
  });

  it('recoverStale：lease 过期且未超 deadline → 重入队；run deadline 已过 → timeout（lease 过期 ≠ run 超时）', async () => {
    const lease = worker.get(AgentRunLeaseService);
    const freshRun = await prisma.agentRun.create({
      data: { userId, agentId, status: 'running', workerId: 'lost-worker', leaseUntil: new Date(Date.now() - 1000), startedAt: new Date() },
    });
    const oldRun = await prisma.agentRun.create({
      data: { userId, agentId, status: 'running', workerId: 'lost-worker', leaseUntil: new Date(Date.now() - 1000), startedAt: new Date(Date.now() - 50 * 60_000) },
    });
    const queuedOld = await prisma.agentRun.create({
      data: { userId, agentId, status: 'queued', startedAt: new Date(Date.now() - 50 * 60_000) },
    });
    createdRunIds.push(freshRun.id, oldRun.id, queuedOld.id);

    const res = await lease.recoverStale();
    expect(res.reEnqueued).toBeGreaterThanOrEqual(1);
    expect(res.timedOut).toBeGreaterThanOrEqual(2); // oldRun + queuedOld

    expect((await prisma.agentRun.findUnique({ where: { id: oldRun.id } }))?.status).toBe('timeout');
    expect((await prisma.agentRun.findUnique({ where: { id: queuedOld.id } }))?.status).toBe('timeout');
    // freshRun 未被 timeout（lease 过期 ≠ run 超时）→ 由重入队恢复
    expect((await prisma.agentRun.findUnique({ where: { id: freshRun.id } }))?.status).toBe('running');
  });
});
