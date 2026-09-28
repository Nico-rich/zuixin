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
import { SseRegistryService } from '../src/core/sse/sse-registry.service';

/**
 * M10-P13（审计 ARCH-07）**对话流**（POST /api/v1/chat 的 SSE）接收 task 通道事件 —— 前端真正消费的那条链路。
 *
 * 与 m10-p13-task-sse.e2e-spec.ts（agent-runs 观察流）互补：两者都经同一套
 * TaskChannelRelayService → SseRegistryService.deliver 投递，但**连接的注册方不同**
 * （chat.controller 注册 'chat' 连接，带 Express res.req 推导的 {userId, conversationId}）。
 * 本用例在 HTTP 层验证 ARCH-07 的路由契约：
 *   1) 同一会话的 task.progress → 进入该对话的 SSE 流（payload 原样，round-trip 检查）；
 *   2) 同一用户**其他会话**的任务 → 绝不进入本对话的流（按 conversation 收敛，不是按 user 广播）。
 *
 * 注：Redis Pub/Sub 与逻辑库无关（实测 db0 的发布能到达 db32 订阅者），故负向断言按唯一 taskId 收敛。
 *   REDIS_URL=redis://localhost:6379/32 npx vitest run test/m10-p13-chat-task-sse.e2e-spec.ts
 */
const XRW = 'XMLHttpRequest';
const TASK_CHANNEL = 'agent:events:task';

interface ChatFrame { event: string; data: Record<string, unknown> }

/** 长连接探针：POST /chat 的 SSE 流（与 AgentRuns 观察流不同，这里是 POST + 请求体） */
class ChatStreamProbe {
  frames: ChatFrame[] = [];
  closed = false;
  private buffer = '';

  constructor(private readonly req: http.ClientRequest, res: http.IncomingMessage) {
    res.on('data', (c: Buffer) => this.parse(c.toString()));
    res.on('end', () => { this.closed = true; });
    res.on('error', () => { this.closed = true; });
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
      try { this.frames.push({ event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> }); } catch { /* 非 JSON 帧忽略 */ }
    }
  }

  async waitOrNull(predicate: (f: ChatFrame) => boolean, timeoutMs: number): Promise<ChatFrame | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.find(predicate);
      if (hit) return hit;
      if (this.closed || Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  destroy(): void { this.req.destroy(); }
}

describe('M10-P13 对话流 × task 通道 SSE (e2e, 真实 HTTP/Redis/PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let relay: TaskChannelRelayService;
  let redis: Redis;
  let cookie: string;
  let userId = '';
  let agentId = '';
  let convId = '';       // 本对话（连接归属）
  let otherConvId = '';  // 同用户的另一个会话（负向）
  const taskIds: string[] = [];
  let port = 0;

  const newTask = async (conversationId: string) => {
    const t = await prisma.generationTask.create({
      data: { userId, conversationId, type: 'image', status: 'processing', progress: 5, input: { prompt: 'chat stream sse' } },
    });
    taskIds.push(t.id);
    return t.id;
  };

  beforeAll(async () => {
    // mock 逐字符流式：延迟决定 run 时长 → 决定"对话流开着"的窗口。
    // 注意用**不触发工具启发式**的消息（含"图/视频/方案…"会让替身立刻 yield tool_calls 并结束回合，
    // run 不经历逐字流式，窗口缩到毫秒级——本套件要的正是"对话进行中"的窗口）。
    process.env.MOCK_DELAY_MS = '150';
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

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('X-Requested-With', XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id;

    const conv = await prisma.conversation.create({ data: { userId, title: 'M10-P13 对话流 SSE' } });
    const other = await prisma.conversation.create({ data: { userId, title: 'M10-P13 其他会话' } });
    convId = conv.id; otherConvId = other.id;

    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    redis.on('error', () => undefined); // 共享 Redis 的瞬时抖动只静音，不影响断言
  });

  afterAll(async () => {
    // 未挂到 run 的任务：只可能被 usage 引用，先删引用再删任务；会话随任务一起清理
    if (taskIds.length) {
      await prisma.usageRecord.deleteMany({ where: { taskId: { in: taskIds } } }).catch(() => undefined);
      await prisma.generationTask.deleteMany({ where: { id: { in: taskIds } } }).catch(() => undefined);
    }
    await prisma.message.deleteMany({ where: { conversationId: { in: [convId, otherConvId].filter(Boolean) } } }).catch(() => undefined);
    await prisma.conversation.deleteMany({ where: { id: { in: [convId, otherConvId].filter(Boolean) } } }).catch(() => undefined);
    redis?.disconnect();
    await app?.close();
  });

  /** 打开一条真实的对话 SSE 流（POST /chat；带 conversationId → 连接归属含会话维度） */
  function openChatStream(): Promise<ChatStreamProbe> {
    // 纯文本消息：不命中 mock 的工具启发式 → 逐字符流式 → 对话流在整个断言窗口内保持打开
    const body = JSON.stringify({ conversationId: convId, message: '你好，介绍一下你自己（M10-P13 对话流测试）' });
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/api/v1/chat', method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'X-Requested-With': XRW,
          Cookie: cookie, Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => resolve(new ChatStreamProbe(req, res)));
      req.on('error', reject);
      req.end(body);
    });
  }

  it('对话进行中：本会话 task.progress 进入该对话流；同用户其他会话的进度绝不进入', async () => {
    expect(relay.isDegraded()).toBe(false);
    const registry = app.get(SseRegistryService);
    const mine = await newTask(convId);
    const others = await newTask(otherConvId);

    const stream = await openChatStream();
    try {
      // message_start 到达 = 连接已建立并完成注册（此后 relay 才能路由到它）
      const start = await stream.waitOrNull((f) => f.event === 'message_start', 10000);
      expect(start?.data.conversationId).toBe(convId);

      // 归属元数据来自 res.req 推导（chat.controller 未改一行）：userId + 请求体里的 conversationId。
      // 这是本用例成立的前提——没有它 relay 无法把事件收敛到"相关连接"。
      const conn = registry.snapshot().find((c) => c.kind === 'chat');
      expect(conn).toMatchObject({ kind: 'chat', userId, conversationId: convId });

      // 负向：同用户、**不同会话**的任务 → 不进入本对话的流（ARCH-07 的按会话收敛）
      for (let i = 0; i < 3; i++) {
        await redis.publish(TASK_CHANNEL, JSON.stringify({ type: 'task.progress', taskId: others, progress: 90, message: '别的会话' })).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(stream.frames.some((f) => f.data.taskId === others)).toBe(false);

      // 正向：本会话任务 → 到达本对话流（payload 原样透传）
      const frame = { type: 'task.progress', taskId: mine, progress: 33, message: '生成中 33%' };
      let seen = false;
      const deadline = Date.now() + 5000;
      while (!seen && Date.now() < deadline) {
        await redis.publish(TASK_CHANNEL, JSON.stringify(frame)).catch(() => undefined);
        seen = (await stream.waitOrNull((f) => f.event === 'task.progress' && f.data.taskId === mine, 300)) !== null;
      }
      expect(seen).toBe(true);
      const got = stream.frames.find((f) => f.event === 'task.progress' && f.data.taskId === mine)!;
      expect(got.data).toEqual(frame);
      // 事件是在**对话流进行中**推送的（不是收流后的批量补发）：run 仍未被终态帧收尾
      expect(stream.frames.some((f) => f.event === 'message_end')).toBe(false);
    } finally {
      stream.destroy();
    }
  });
});
