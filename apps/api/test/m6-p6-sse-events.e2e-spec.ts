import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import http from 'node:http';
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

/** 最小 SSE 客户端：解析 event:/data: 块；支持条件等待与流结束等待 */
class SSEClient {
  events: Array<{ event: string; data: Record<string, unknown> }> = [];
  ended = false;
  private buffer = '';

  constructor(private readonly req: http.ClientRequest, res: http.IncomingMessage) {
    res.on('data', (chunk: Buffer) => this.parse(chunk.toString()));
    res.on('end', () => { this.ended = true; });
    res.on('error', () => { this.ended = true; });
  }

  private parse(text: string) {
    this.buffer += text;
    const blocks = this.buffer.split('\n\n');
    this.buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      if (!dataLines.length) continue;
      try {
        this.events.push({ event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> });
      } catch { /* ping 注释等非 JSON 行忽略 */ }
    }
  }

  async waitFor(predicate: (evt: { event: string; data: Record<string, unknown> }) => boolean, timeoutMs = 15_000): Promise<{ event: string; data: Record<string, unknown> }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.events.find(predicate);
      if (found) return found;
      if (this.ended) throw new Error(`SSE 流已结束，未等到目标事件`);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`SSE 未在 ${timeoutMs}ms 内等到目标事件（已收 ${this.events.map((e) => e.event).join(',')}）`);
  }

  async waitEnded(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.ended) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('SSE 流未在预期时间内结束');
  }

  destroy() { this.req.destroy(); }
}

function connectSse(port: number, path: string, cookie: string, lastEventId?: string): Promise<SSEClient> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'X-Requested-With': 'XMLHttpRequest', Cookie: cookie, Accept: 'text/event-stream',
    };
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      resolve(new SSEClient(req, res));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * M6-P6 e2e（真实 PostgreSQL + Redis + Worker）：
 * SSE 订阅全生命周期（snapshot + realtime + waiting/task/resume 事件）、断线重连 Last-Event-ID 补段、
 * 完成后重连最终状态、SSE 断线不影响 Runtime、越权 404。
 */
describe('M6-P6 SSE 观察层 (e2e, 真实 Queue + Worker + Redis Pub/Sub)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let cookieB: string;
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

    const userB = await prisma.user.create({ data: { email: `userb-p6-${Date.now()}@example.com`, passwordHash: 'unused-hash' } });
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);
    cookieB = `agent_access=${await jwt.signAsync({ sub: userB.id, role: 'user' })}`;

    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
    const { Queue } = await import('bullmq');
    imageQueue = new Queue('image', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null } });
  });

  afterAll(async () => {
    await imageQueue?.resume().catch(() => undefined);
    await imageQueue?.close().catch(() => undefined);
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

  it('P6-1/P6-4 全生命周期订阅：snapshot → 实时事件 → run.waiting → task.completed → run.completed → 流结束（终态）', async () => {
    await imageQueue.pause(); // 确定性 waiting
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '画一张黑金配色主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);

    const port = (app.getHttpServer().address() as { port: number }).port;
    const client = await connectSse(port, `/api/v1/agent-runs/${runId}/events`, cookie);

    // 1. 快照基线（Timeline 投影）
    const snapshot = await client.waitFor((e) => e.event === 'timeline.snapshot');
    expect(snapshot.data.runId).toBe(runId);
    expect(snapshot.data.terminal).toBe(false);
    const items = snapshot.data.items as Array<{ id: string; type: string }>;
    expect(items.some((i) => i.type === 'run.started')).toBe(true);

    // 2. 实时事件（worker 经 Redis Pub/Sub 转发）：engine agent.start
    await client.waitFor((e) => e.event === 'agent.start');
    // 3. waiting 事件（任务未终态 → run 转 waiting）
    const waitingEvt = await client.waitFor((e) => e.event === 'run.waiting');
    expect(waitingEvt.data.taskId).toBeTruthy();

    // 4. 任务完成 → task.completed 实时事件 + 唤醒 resume → 最终 run.completed
    await imageQueue.resume();
    await client.waitFor((e) => e.event === 'task.completed');
    const completed = await client.waitFor((e) => e.event === 'run.completed');
    expect((completed.data as { status: string }).status).toBe('completed');
    await client.waitEnded(); // 终态：快照即最终事实，流结束
    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status).toBe('completed');
  });

  it('P6-2/P6-6 断线重连 Last-Event-ID：只补缺失段；断线不影响 Runtime；完成后重连可见最终状态', async () => {
    await imageQueue.pause();
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '画一张黑金配色主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    const port = (app.getHttpServer().address() as { port: number }).port;

    // 连接 1：拿到快照并记录断点（最后一条 item id），随后主动断线
    const client1 = await connectSse(port, `/api/v1/agent-runs/${runId}/events`, cookie);
    const snapshot1 = await client1.waitFor((e) => e.event === 'timeline.snapshot');
    expect(snapshot1.data.runId).toBe(runId);
    await client1.waitFor((e) => e.event === 'run.waiting');
    client1.destroy();
    await new Promise((r) => setTimeout(r, 300));
    // 断点 = 任务项 id（行 id 恒定，type 状态演进 task.created → task.completed——
    // snapshot items 是 id 幂等的 upsert；断点之前的段不重发，断点项以更新后状态重发）
    const { AgentRunTimelineService } = await import('../src/modules/agent-runs/agent-run-timeline.service');
    const midTimeline = await app.get(AgentRunTimelineService).build(userId, runId);
    const taskItem = midTimeline.items.find((i) => i.id.startsWith('task-'));
    expect(taskItem).toBeTruthy(); // waiting 时任务项必已存在（task.created）
    const cursor = taskItem!.id;

    // 断线期间任务完成 → run 被唤醒 → 终态（P6-5：SSE 断线绝不影响 Runtime）
    await imageQueue.resume();
    expect(await waitForStatus(prisma, runId, ['completed', 'failed', 'timeout'], 30_000)).toBe('completed');

    // 连接 2（Last-Event-ID）：快照只含断点之后的新增段（task.completed/run.completed），不重复已见段
    const client2 = await connectSse(port, `/api/v1/agent-runs/${runId}/events`, cookie, cursor);
    const snapshot2 = await client2.waitFor((e) => e.event === 'timeline.snapshot');
    expect(snapshot2.data.terminal).toBe(true);
    const items2 = snapshot2.data.items as Array<{ id: string; type: string }>;
    // 断线期间的事件由快照补齐；断点之前的段不重发（断点项自身按 upsert 语义允许以更新后的状态重发）
    expect(items2.some((i) => i.type === 'task.completed')).toBe(true);
    expect(items2.some((i) => i.type === 'run.completed')).toBe(true); // 最终状态可见
    expect(items2.some((i) => i.type === 'run.started')).toBe(false); // 断点之前的历史段不重发
    await client2.waitEnded();
  });

  it('P6-6 完成后新连接：terminal 快照即最终事实（无需实时通道）', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 20_000)).toBe('completed');

    const port = (app.getHttpServer().address() as { port: number }).port;
    const client = await connectSse(port, `/api/v1/agent-runs/${runId}/events`, cookie);
    const snapshot = await client.waitFor((e) => e.event === 'timeline.snapshot');
    expect(snapshot.data.terminal).toBe(true);
    expect((snapshot.data.items as Array<{ type: string }>).some((i) => i.type === 'run.completed')).toBe(true);
    await client.waitEnded();
  });

  it('P6-1 越权：他人 run events → 404（防枚举）；匿名 401', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    await request(app.getHttpServer()).get(`/api/v1/agent-runs/${runId}/events`).set(XRW).expect(401);
    if (cookieB) {
      await request(app.getHttpServer()).get(`/api/v1/agent-runs/${runId}/events`).set(XRW).set('Cookie', cookieB)
        .expect(404);
    }
  });
});
