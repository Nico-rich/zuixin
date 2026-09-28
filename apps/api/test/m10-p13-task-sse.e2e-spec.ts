import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { TaskChannelRelayService } from '../src/core/sse/task-channel-relay.service';

/**
 * M10-P13（审计 ARCH-07）task 通道 → SSE 转发**全链路 e2e**（真实 HTTP/SSE + 真实 Redis Pub/Sub + 真实 PostgreSQL）。
 *
 * 链路：外部发布者（模拟 Worker 的 media-generation）→ Redis `agent:events:task` → API 进程的
 * TaskChannelRelayService（订阅 + 按 owner 解析）→ 已注册的 SSE 连接（agent-runs 观察流）→ HTTP 客户端。
 *
 * 断言的是**客户端可见的事实**：帧到达、payload 原样、越权任务绝不出现；并覆盖 relay 在真实
 * AppModule 图里确实建立订阅（degraded=false）。
 *
 * 隔离须知（实测，勿按"逻辑库隔离"推理）：Redis Pub/Sub **不受逻辑库约束**——db0 的发布能到达 db32 的
 * 订阅者（`CLIENT INFO` 各自的 db= 正确，keyspace 才分库；发布/订阅是全局的）。因此 REDIS_URL 的 DB 段
 * 对"通道噪音"无效，本套件与并行套件共享 `agent:events:task` 通道。据此：
 * - 所有负向断言都按 **taskId** 收敛（uuid 唯一，跨套件不会撞车），而不是"通道上什么都没发生"；
 * - 真正的安全边界由 relay 的归属路由（fail-closed）保证：越权任务的事件即使到了本 API 进程也不会投给本连接。
 *   REDIS_URL=redis://localhost:6379/32 npx vitest run test/m10-p13-task-sse.e2e-spec.ts
 */
const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
/** event-bus 的通道前缀（core/events/event-bus.service.ts） */
const TASK_CHANNEL = 'agent:events:task';

interface SseFrame { event: string; data: Record<string, unknown> }

class SseProbe {
  frames: SseFrame[] = [];
  ended = false;
  private buffer = '';

  constructor(private readonly req: http.ClientRequest, res: http.IncomingMessage) {
    res.on('data', (chunk: Buffer) => this.parse(chunk.toString()));
    res.on('end', () => { this.ended = true; });
    res.on('error', () => { this.ended = true; });
  }

  private parse(text: string): void {
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
      try { this.frames.push({ event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> }); } catch { /* ping 注释 */ }
    }
  }

  /** 在窗口内等待某帧（超时返回 null，供"不该出现"类断言使用） */
  async waitOrNull(predicate: (f: SseFrame) => boolean, timeoutMs: number): Promise<SseFrame | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.find(predicate);
      if (hit) return hit;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  destroy(): void { this.req.destroy(); }
}

function connectSse(port: number, path: string, cookie: string): Promise<SseProbe> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'GET',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Cookie: cookie, Accept: 'text/event-stream' },
    }, (res) => resolve(new SseProbe(req, res)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 反复发布同一事件直到收到目标帧（或超时）——Redis Pub/Sub 对"订阅建立瞬间"的消息不重放，
 * 转发链路按 at-least-once 观察，重复帧对客户端是幂等 upsert（与 worker 反复上报进度的语义一致）。
 * 用于**正向**断言（等到帧 = 链路通）。返回尝试次数。
 */
async function publishUntilSeen(
  redis: Redis, frame: Record<string, unknown>, client: SseProbe,
  predicate: (f: SseFrame) => boolean, timeoutMs = 8000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    attempts++;
    try { await redis.publish(TASK_CHANNEL, JSON.stringify(frame)); } catch (err) { lastErr = err as Error; }
    const hit = await client.waitOrNull(predicate, 300);
    if (hit) return attempts;
  }
  throw new Error(`未在 ${timeoutMs}ms 内收到转发帧（事件 ${String(frame.type)}，已尝试 ${attempts} 次）${lastErr ? `；末次发布错误: ${lastErr.message}` : ''}`);
}

/** 反复发布（负向断言用）：确认在足够长窗口内**始终**收不到 → 不是竞态导致的"恰好错过" */
async function publishRepeatedlyFor(
  redis: Redis, frame: Record<string, unknown>, windowMs: number, channel = TASK_CHANNEL,
): Promise<number> {
  const deadline = Date.now() + windowMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    // 发布端瞬时断连（共享 Redis 被其他套件 churn）不应让"发布次数"断言失真
    try { await redis.publish(channel, JSON.stringify(frame)); } catch { /* ioredis 自动重连，下一轮继续 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return attempts;
}

describe('M10-P13 task 通道 → SSE 转发 (e2e, 真实 Redis/PostgreSQL/HTTP)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let relay: TaskChannelRelayService;
  let redis: Redis;
  let cookie: string;
  let userId = '';
  let otherUserId = '';
  let agentId = '';
  const runIds: string[] = [];
  const taskIds: string[] = [];
  let port = 0;

  const newRun = async (owner: string) => {
    const run = await prisma.agentRun.create({ data: { userId: owner, agentId, status: 'running' } });
    runIds.push(run.id);
    return run.id;
  };
  const newTask = async (owner: string) => {
    const task = await prisma.generationTask.create({
      data: { userId: owner, type: 'image', status: 'processing', progress: 10, input: { prompt: 'e2e task sse' } },
    });
    taskIds.push(task.id);
    return task.id;
  };

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
    port = (app.getHttpServer().address() as { port: number }).port;

    prisma = moduleRef.get(PrismaService);
    relay = moduleRef.get(TaskChannelRelayService);
    const agent = await prisma.agent.findFirstOrThrow({ where: { slug: 'general-assistant' }, select: { id: true } });
    agentId = agent.id;

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id;
    const other = await prisma.user.create({ data: { email: `m10p13-other-${Date.now()}@example.com`, passwordHash: 'unused-hash' } });
    otherUserId = other.id;

    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    // 共享 Redis 被并行套件 churn 时会出现瞬时 ECONNRESET；ioredis 自愈重连，这里只静音噪音
    redis.on('error', () => undefined);
  });

  afterAll(async () => {
    redis?.disconnect();
    if (taskIds.length) {
      await prisma.usageRecord.deleteMany({ where: { taskId: { in: taskIds } } }).catch(() => undefined);
      await prisma.generationTask.deleteMany({ where: { id: { in: taskIds } } }).catch(() => undefined);
    }
    if (runIds.length) await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => undefined);
    if (otherUserId) await prisma.user.deleteMany({ where: { id: otherUserId } }).catch(() => undefined);
    await app?.close();
  });

  it('转发器在真实 AppModule 图中已订阅（degraded=false）——否则降级并暴露统计', () => {
    expect(relay.isDegraded()).toBe(false);
    expect(relay.stats().subscribeFailures).toBe(0);
  });

  it('P13-1 全链路：task.progress / task.completed → SSE 帧（payload 原样透传，快照先于转发）', async () => {
    const runId = await newRun(userId);
    const taskId = await newTask(userId);
    const client = await connectSse(port, `/api/v1/agent-runs/${runId}/events`, cookie);
    try {
      const snapshot = await client.waitOrNull((f) => f.event === 'timeline.snapshot', 5000);
      expect(snapshot?.data.runId).toBe(runId);
      expect(snapshot?.data.terminal).toBe(false);

      await publishUntilSeen(redis, { type: 'task.progress', taskId, progress: 42, message: '生成中 42%' }, client,
        (f) => f.event === 'task.progress' && f.data.taskId === taskId);

      const progressFrame = client.frames.find((f) => f.event === 'task.progress' && f.data.taskId === taskId)!;
      // payload 原样（不新造/不裁剪字段）：与 shared/events.ts 的 task.progress schema 一致
      expect(progressFrame.data).toEqual({ type: 'task.progress', taskId, progress: 42, message: '生成中 42%' });
      // 顺序契约：快照是连接的基线（客户端据此初始化，再消费增量）
      expect(client.frames.findIndex((f) => f.event === 'timeline.snapshot'))
        .toBeLessThan(client.frames.findIndex((f) => f.event === 'task.progress'));

      await publishUntilSeen(redis, { type: 'task.completed', taskId, progress: 100 }, client,
        (f) => f.event === 'task.completed' && f.data.taskId === taskId);
      expect(relay.stats().forwarded).toBeGreaterThan(0);
    } finally {
      client.destroy();
    }
  });

  it('P13-2 越权隔离：他人任务的进度事件绝不进入本连接（含未知/伪造 taskId；断言按 taskId 收敛）', async () => {
    const runId = await newRun(userId);
    const foreignTaskId = await newTask(otherUserId);
    const client = await connectSse(port, `/api/v1/agent-runs/${runId}/events`, cookie);
    try {
      await client.waitOrNull((f) => f.event === 'timeline.snapshot', 5000);

      const attempts = await publishRepeatedlyFor(redis, { type: 'task.progress', taskId: foreignTaskId, progress: 99, message: '他人任务' }, 1500);
      expect(attempts).toBeGreaterThan(3); // 确实反复发布过（不是"恰好错过"）
      expect(client.frames.some((f) => f.data.taskId === foreignTaskId)).toBe(false);

      // 未知 taskId（伪造/已清理）同样 fail-closed
      await publishRepeatedlyFor(redis, { type: 'task.progress', taskId: '00000000-0000-0000-0000-000000000000', progress: 1 }, 800);
      expect(client.frames.some((f) => f.data.taskId === '00000000-0000-0000-0000-000000000000')).toBe(false);
    } finally {
      client.destroy();
    }
  });

  /**
   * 通道作用域自检（**实测结论，勿再按"逻辑库隔离"推理**）：
   * Redis Pub/Sub 与 keyspace 无关——**逻辑库不隔离发布/订阅**。实测（CLIENT INFO db=0 / db=32 各自正确）
   * 发往 db0 的 `agent:events:task` 会到达 db32 的订阅者。因此：
   * - 本套件与其他 Agent 套件即使约定不同 DB 段，**仍共享同一批 channel**；跨套件的同通道噪音无法靠 DB 段隔离；
   * - 真正的作用域只有 **channel 名**（以及"事件里的 taskId + 连接归属"）。
   * 本用例锁定我们依赖的那条：转发器只订阅 `agent:events:task`，发往旁路通道的同一事件绝不进入本连接。
   */
  it('P13-4 通道作用域自检：发往旁路通道的同一事件不会到达本连接（订阅面精确为 agent:events:task）', async () => {
    const runId = await newRun(userId);
    const taskId = await newTask(userId);
    const client = await connectSse(port, `/api/v1/agent-runs/${runId}/events`, cookie);
    try {
      await client.waitOrNull((f) => f.event === 'timeline.snapshot', 5000);
      const frame = { type: 'task.progress', taskId, progress: 77, message: '旁路通道噪音' };
      // 同一发布端、同一 payload，只改通道名（前缀仍是 event-bus 的 agent:events:）
      const attempts = await publishRepeatedlyFor(redis, frame, 1000, 'agent:events:task-shadow');
      expect(attempts).toBeGreaterThan(3);
      expect(client.frames.some((f) => f.data.taskId === taskId)).toBe(false);
      // 反证：同一事件走正牌通道确实能到 —— 差异只能来自通道名，而非链路本身不通
      await publishUntilSeen(redis, frame, client, (f) => f.event === 'task.progress' && f.data.taskId === taskId);
    } finally {
      client.destroy();
    }
  });

  it('P13-3 非 task.* 事件名不转发（通道上混入其他事件时不会被透传）', async () => {
    const runId = await newRun(userId);
    const taskId = await newTask(userId);
    const client = await connectSse(port, `/api/v1/agent-runs/${runId}/events`, cookie);
    try {
      await client.waitOrNull((f) => f.event === 'timeline.snapshot', 5000);
      await publishRepeatedlyFor(redis, { type: 'run.completed', taskId, runId, status: 'completed' }, 800);
      expect(client.frames.some((f) => f.data.taskId === taskId)).toBe(false);
      expect(client.frames.some((f) => f.event === 'run.completed')).toBe(false);
    } finally {
      client.destroy();
    }
  });
});
