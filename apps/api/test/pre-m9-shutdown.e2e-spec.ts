import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { SseRegistryService } from '../src/core/sse/sse-registry.service';
import { AGENT_RUN_QUEUE } from '../src/core/queue/queue.module';
import { LifecycleRegistry, SHUTDOWN_STEPS } from '../src/lifecycle/lifecycle-registry';
import { registerGracefulShutdown } from '../src/lifecycle/graceful-shutdown';

/**
 * Pre-M9 G3 优雅停机 e2e（真实 PostgreSQL + Redis + BullMQ Worker + 真实 HTTP/SSE 连接）。
 *
 * 断言的是**停机序列的可观测后果**，不是"钩子被调用过"：
 * ① API 进程：排空期新 SSE 订阅 → 503（已有流不受影响）→ 真停机序列 → 已建流收到**干净 EOF**
 *    （`res.complete === true`，不是 socket 被强杀）→ 连接从纳管集合注销 → **exit 0（绝无 exit(1)）**；
 * ② 停机阶段顺序 = SHUTDOWN_STEPS 的子序列且严格递增（stopAcceptingHttp → stopSseSubscriptions → drainSse → …）；
 * ③ Worker 进程：在途 AgentRun（真实 Engine 正在跑 LLM 流）→ 到达 finalizeLeases 时 **lease 已置 null**
 *    （run 行仍为 running：Engine 未写终态 → 新 worker 可立即接管），且 closeBullmq 不中断 job；
 * ④ 超时/失败语义由 graceful-shutdown 单测覆盖（本文件只验证真实路径不产生 exit(1)）。
 *
 * 必须使用独立 Redis DB（共享队列跨版本污染）：
 *   REDIS_URL=redis://localhost:6379/2 npx vitest run test/pre-m9-shutdown.e2e-spec.ts
 */
const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const SILENT = { log: () => undefined, warn: () => undefined, error: () => undefined };
const redisConn = () => ({ url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null });

interface SseFrame { event: string; data: Record<string, unknown> }

/** 最小 SSE 客户端：除帧解析外，记录**客户端视角的结束方式**（干净 EOF vs 连接被重置） */
class SseProbe {
  frames: SseFrame[] = [];
  ended = false;
  /** 响应被完整接收（服务端 end 正常收尾）；被强杀/重置时 Node 置 res.complete=false */
  complete = false;
  private buffer = '';

  constructor(private readonly req: http.ClientRequest, res: http.IncomingMessage) {
    res.on('data', (chunk: Buffer) => this.parse(chunk.toString()));
    res.on('end', () => { this.ended = true; this.complete = res.complete; });
    res.on('aborted', () => { this.ended = true; this.complete = false; });
    res.on('error', () => { this.ended = true; this.complete = false; });
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
      try {
        this.frames.push({ event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> });
      } catch { /* ping 注释等非 JSON 行 */ }
    }
  }

  async waitFor(predicate: (f: SseFrame) => boolean, timeoutMs = 15_000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.find(predicate);
      if (hit) return hit;
      if (this.ended) throw new Error(`SSE 流已结束，未等到目标帧（已收 ${this.frames.map((f) => f.event).join(',')}）`);
      if (Date.now() >= deadline) {
        throw new Error(`SSE 未在 ${timeoutMs}ms 内等到目标帧（已收 ${this.frames.map((f) => f.event).join(',')}）`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async waitEnded(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.ended) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('SSE 流未在预期时间内结束（停机未能关闭长连接 = 会挂住发布）');
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

/** 等待回调返回 true（轮询） */
async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Pre-M9 G3 优雅停机 (e2e, 真实 HTTP/SSE/BullMQ)', () => {
  let prisma: PrismaService;
  const runIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  }, 30_000);

  afterAll(async () => {
    // 本文件队列只属于本 worktree 的独立 Redis DB（DB 2）；清空避免残留 job 影响后续文件
    const queue = new Queue(AGENT_RUN_QUEUE, { connection: redisConn() });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    if (runIds.length) {
      await prisma.generationTask.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
      await prisma.artifact.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
      await prisma.usageRecord.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
      await prisma.quotaReservation.deleteMany({ where: { refId: { in: runIds } } }).catch(() => undefined);
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
      await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => undefined);
    }
    await prisma?.$disconnect().catch(() => undefined);
  }, 60_000);

  it('API 进程：排空拒绝新订阅(503) → 已建 SSE 干净 EOF → 阶段顺序严格 → exit 0（无 exit(1)）', async () => {
    process.env.MOCK_DELAY_MS = '0';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const api = moduleRef.createNestApplication();
    api.use(cookieParser());
    api.use('/api/v1', csrfProtection);
    api.setGlobalPrefix('api/v1');
    api.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    api.useGlobalInterceptors(new TransformInterceptor());
    await api.init();
    await api.listen(0);
    const port = (api.getHttpServer().address() as { port: number }).port;

    let closed = false;
    try {
      const login = await request(api.getHttpServer()).post('/api/v1/auth/login').set(XRW)
        .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
      expect([200, 201]).toContain(login.status);
      const cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');

      // 在途 run（本文件此时没有 worker → 保持 queued/running 非终态，SSE 流保持打开）
      const created = await request(api.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
        .send({ message: 'G3 停机探针：在途订阅' })
        .expect(201);
      const runId = created.body.data.runId as string;
      runIds.push(runId);

      // ① 真实长连接订阅（快照到达 = 流已建立并纳管）
      const client = await connectSse(port, `/api/v1/agent-runs/${runId}/events`, cookie);
      await client.waitFor((f) => f.event === 'timeline.snapshot');
      const sse = api.get(SseRegistryService);
      expect(sse.size()).toBe(1);
      expect(sse.snapshot()[0]!.kind).toBe('agent-run-events');

      // ② 排空期：新订阅被拒（503 服务端状态裁决），已有流不受影响
      sse.beginDrain();
      const rejected = await request(api.getHttpServer()).get(`/api/v1/agent-runs/${runId}/events`).set(XRW).set('Cookie', cookie);
      expect(rejected.status).toBe(503);
      expect((rejected.body as { error?: { code?: string } }).error?.code).toBe('INTERNAL');
      expect(sse.size()).toBe(1); // 已有连接仍在纳管集合（排空 ≠ 立刻断开）

      // ③ 真停机（模拟 SIGTERM：直接调用 handler，不发真信号——发信号会杀掉 vitest 进程）
      const exits: number[] = [];
      const steps: string[] = [];
      const handle = registerGracefulShutdown(api, {
        signals: [], timeoutMs: 20_000, logger: SILENT,
        exit: (code) => exits.push(code),
        onStep: (r) => steps.push(r.step),
      });
      const events = await handle.shutdown('SIGTERM');
      closed = true;

      expect(events.map((e) => e.phase)).toEqual(['start', 'closing', 'closed']);
      expect(events.at(-1)!.exitCode).toBe(0);
      expect(exits).toEqual([0]); // 绝不 exit(1)（挂住 → 被迫强退才算失败）

      // ④ 长连接被优雅关闭：客户端收到**干净 EOF**（而非连接重置）
      await client.waitEnded(10_000);
      expect(client.complete).toBe(true);
      expect(sse.size()).toBe(0); // 连接已从纳管集合移除
      expect(sse.isDraining()).toBe(true);

      // ⑤ 阶段顺序：观测到的阶段是 SHUTDOWN_STEPS 的子序列，且严格递增（无乱序/重复执行）
      expect(steps).toContain('stopAcceptingHttp');
      expect(steps).toContain('stopSseSubscriptions');
      expect(steps).toContain('drainSse');
      const ranked = steps.map((s) => SHUTDOWN_STEPS.indexOf(s as (typeof SHUTDOWN_STEPS)[number]));
      expect(ranked.every((i) => i >= 0)).toBe(true); // 无未定义阶段
      expect(ranked).toEqual([...ranked].sort((a, b) => a - b)); // 严格按权威顺序
      expect(ranked.indexOf(SHUTDOWN_STEPS.indexOf('stopAcceptingHttp')))
        .toBeLessThan(ranked.indexOf(SHUTDOWN_STEPS.indexOf('stopSseSubscriptions')));
      expect(ranked.indexOf(SHUTDOWN_STEPS.indexOf('stopSseSubscriptions')))
        .toBeLessThan(ranked.indexOf(SHUTDOWN_STEPS.indexOf('drainSse')));
      handle.dispose();
    } finally {
      if (!closed) await api.close().catch(() => undefined);
    }
  }, 120_000);

  it('Worker 进程：在途 job 的 lease 在 finalizeLeases 阶段已释放（run 仍 running → 可被接管），且 exit 0', async () => {
    // 前置：清空队列残留 job（本 worktree 独立 Redis DB），并把本文件此前创建的未终态 run 置 cancelled
    //（否则它们会被本测试的 worker 认领，抢占处理器的单 active 槽位 → 干扰"在途 job"断言）
    const queue = new Queue(AGENT_RUN_QUEUE, { connection: redisConn() });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    if (runIds.length) {
      await prisma.agentRun.updateMany({
        where: { id: { in: runIds }, status: { in: ['queued', 'running', 'waiting'] } },
        data: { status: 'cancelled' },
      });
    }
    const seed = await prisma.agent.findFirstOrThrow({ where: { slug: 'general-assistant' }, include: { activeVersion: true } });
    const owner = await prisma.user.findFirstOrThrow({ where: { email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com' } });

    // 慢速 mock 流（150ms/字符 × ~36 字符 ≈ 5s）→ 停机时 Engine 确定性地处于"在途 LLM 调用"
    const prevDelay = process.env.MOCK_DELAY_MS;
    process.env.MOCK_DELAY_MS = '150';
    const worker: INestApplicationContext = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
    try {
      const run = await prisma.agentRun.create({
        data: {
          userId: owner.id,
          agentId: seed.id, agentVersionId: seed.activeVersion!.id,
          status: 'queued', startedAt: new Date(), maxSteps: 8, metadata: {},
        },
      });
      runIds.push(run.id);
      await prisma.agentRunMessage.create({ data: { runId: run.id, sequence: 0, role: 'user', content: '在途租约探针' } });

      const workerQueue = worker.get<Queue>(getQueueToken(AGENT_RUN_QUEUE));
      await workerQueue.add('execute', { runId: run.id }, {
        jobId: `prem9-g3-${run.id}`, attempts: 1, removeOnComplete: true, removeOnFail: { count: 500 },
      });

      // 等真实 Engine 认领（lease 写入 = 真的在途执行中）
      await waitUntil(async () => {
        const row = await prisma.agentRun.findUnique({ where: { id: run.id }, select: { leaseUntil: true, status: true } });
        return row?.status === 'running' && row.leaseUntil !== null;
      }, 30_000, 'Engine 认领在途 run（leaseUntil 非空）');

      const exits: number[] = [];
      const steps: string[] = [];
      // 阶段内观测（确定性：注册在参与者之后 → runStep 顺序执行，读到的一定是 finalizeLeases 之后的状态）
      let leasedAtFinalize: Date | null | undefined = undefined;
      let statusAtFinalize: string | undefined;
      worker.get(LifecycleRegistry).register('finalizeLeases', `test:observe-lease-${Date.now()}`, async () => {
        const row = await prisma.agentRun.findUnique({ where: { id: run.id }, select: { leaseUntil: true, status: true } });
        leasedAtFinalize = row?.leaseUntil ?? null;
        statusAtFinalize = row?.status;
      });
      const handle = registerGracefulShutdown(worker, {
        worker: true, signals: [], timeoutMs: 25_000, logger: SILENT,
        exit: (code) => exits.push(code),
        onStep: (r) => { steps.push(r.step); },
      });
      const events = await handle.shutdown('SIGTERM');

      expect(events.map((e) => e.phase)).toEqual(['start', 'closing', 'closed']);
      expect(exits).toEqual([0]); // 无 exit(1)：停机未挂住

      // 核心断言：lease 在 finalizeLeases 内被释放（而不是等 job 自己跑完才顺带清掉）
      expect(steps).toContain('finalizeLeases');
      expect(leasedAtFinalize).toBeNull();
      expect(statusAtFinalize).toBe('running'); // 释放 lease 时 run 仍非终态 = 真的"在途被中止"

      const after = await prisma.agentRun.findUnique({ where: { id: run.id } });
      expect(after!.leaseUntil).toBeNull(); // lease 已释放 → 新 worker 立即可接管
      expect(after!.status).toBe('running'); // Engine 未写终态（controls.active=false，不伪造 cancelled）
      expect(after!.workerId).toBeTruthy(); // workerId 保留作可观测记录
      expect(after!.completedAt).toBeNull();

      // 阶段顺序：停认领 → 释放 lease → 关 BullMQ（在途 job 交给重试/恢复接管）
      const rank = (s: string) => steps.indexOf(s);
      expect(rank('stopClaim')).toBeGreaterThanOrEqual(0);
      expect(rank('stopClaim')).toBeLessThan(rank('finalizeLeases'));
      expect(rank('finalizeLeases')).toBeLessThan(rank('closeBullmq'));
      expect(steps.every((s) => SHUTDOWN_STEPS.includes(s as (typeof SHUTDOWN_STEPS)[number]))).toBe(true);
      handle.dispose();
    } finally {
      if (prevDelay === undefined) delete process.env.MOCK_DELAY_MS;
      else process.env.MOCK_DELAY_MS = prevDelay;
      await worker.close().catch(() => undefined);
    }
  }, 120_000);
});
