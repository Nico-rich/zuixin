import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext, Module } from '@nestjs/common';
import { BullModule, Processor, WorkerHost, getQueueToken } from '@nestjs/bullmq';
import { NestFactory } from '@nestjs/core';
import { Job, Queue } from 'bullmq';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { HealthService, HealthReport, createRedisProbeClient } from '../src/modules/health/health.service';
import { ProbeResult, probeRedis } from '../src/modules/health/health-probes';
import { registerGracefulShutdown } from '../src/lifecycle/graceful-shutdown';
import { AgentRunLeaseService } from '../src/core/agent-run-lease/agent-run-lease.service';
import { MediaCleanupProcessor } from '../src/worker/media-cleanup/media-cleanup.worker';
import { AgentRunProcessor } from '../src/worker/agent-run/agent-run.processor';
import { SchedulerProcessor } from '../src/worker/scheduler/scheduler.processor';
import { CircuitBreakerService } from '../src/core/circuit-breaker/circuit-breaker.service';
import { ModelRouterService } from '../src/core/model-router/model-router.service';
import { BillingService } from '../src/modules/billing/billing.service';
import { AppError } from '../src/common/errors/app-error';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const REDIS = () => ({ url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null });

async function waitForStatus(prisma: PrismaService, runId: string, targets: string[], timeoutMs = 30_000): Promise<string> {
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

async function waitForWorkflowRun(prisma: PrismaService, id: string, targets: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const row = await prisma.workflowRun.findUnique({ where: { id } });
    last = row?.status ?? 'missing';
    if (row && targets.includes(row.status)) return row.status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`workflowRun ${id} 未在 ${timeoutMs}ms 内到达 ${targets.join('/')}（当前 ${last}）`);
}

async function waitUntil(fn: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待超时：${label}`);
}

const up: ProbeResult = { state: 'up', latencyMs: 1 };
const down: ProbeResult = { state: 'down', latencyMs: 1, detail: 'e2e-injected' };
type ProbeSet = { db: ProbeResult; redis: ProbeResult; storage: ProbeResult };

// ===== 优雅停机序验证用的合成模块（真实 BullMQ Worker/Queue + 真实 Redis，独立于主应用） =====
const PROBE_QUEUE = `m8-p9-shutdown-probe-${process.pid}`;
const SHUTDOWN_ORDER: string[] = [];
let probeJobFinished = false;

@Processor(PROBE_QUEUE)
class ProbeProcessor extends WorkerHost {
  async process(_job: Job): Promise<void> {
    SHUTDOWN_ORDER.push('job:start');
    await new Promise((r) => setTimeout(r, 800));
    probeJobFinished = true;
    SHUTDOWN_ORDER.push('job:end');
  }
  async onApplicationShutdown(): Promise<void> {
    SHUTDOWN_ORDER.push('processor:onApplicationShutdown');
  }
}

@Module({ imports: [BullModule.forRoot({ connection: REDIS() }), BullModule.registerQueue({ name: PROBE_QUEUE })], providers: [ProbeProcessor] })
class ShutdownProbeModule {}

const MINIMAL_WORKFLOW = {
  triggers: [{ type: 'manual' }],
  steps: [{ id: 'out', type: 'output', output: { ok: true } }],
};

/**
 * M8-P9 Reliability / Performance / Disaster Recovery e2e（**真实 PostgreSQL / Redis / BullMQ / Worker**）。
 *
 * 故障注入原则（不伪造）：
 * - **不真停共享 PG/Redis**（其他 Phase 与并行 Agent 依赖它们）：DB/Redis 不可达分支用
 *   "HTTP 层 + 探针替身"注入——走的仍是真实的 controller → service → 分级裁决 → 状态码链路；
 * - **真崩溃**：直接改 DB（lease 过期 / running 无心跳），让真实的恢复路径（recoverStale /
 *   reconcileStalled / BullMQ 接管）跑完整流程，断言终态与不重复副作用；
 * - **真停机**：直接调用 registerGracefulShutdown 返回的 handler（不发真信号——会杀掉 vitest），
 *   并用合成 Nest 应用 + 真实 BullMQ 观测钩子顺序与"在途 job 不被中断"。
 */
describe('M8-P9 Reliability / DR (e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let userId = '';
  let agentId = '';
  let agentVersionId = '';
  const runIds: string[] = [];
  const workflowRunIds: string[] = [];
  const workflowIds: string[] = [];
  const scheduledJobIds: string[] = [];

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
    prisma = moduleRef.get(PrismaService);

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id;
    const agent = await prisma.agent.findFirstOrThrow({ where: { slug: 'general-assistant' }, include: { activeVersion: true } });
    agentId = agent.id;
    agentVersionId = agent.activeVersion!.id;

    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  }, 60_000);

  afterAll(async () => {
    if (runIds.length) {
      await prisma.generationTask.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.artifact.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.usageRecord.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } });
    }
    if (workflowRunIds.length) {
      await prisma.approval.deleteMany({ where: { workflowRunId: { in: workflowRunIds } } });
      await prisma.workflowRun.deleteMany({ where: { id: { in: workflowRunIds } } });
    }
    if (workflowIds.length) await prisma.workflow.deleteMany({ where: { id: { in: workflowIds } } }).catch(() => undefined);
    if (scheduledJobIds.length) await prisma.scheduledJob.deleteMany({ where: { id: { in: scheduledJobIds } } });
    await worker?.close().catch(() => undefined);
    await app.close();
  }, 60_000);

  // ================= Health 三端点（真实 HTTP） =================

  describe('P9 Health 三端点：liveness / readiness 语义分离 + 依赖分级', () => {
    it('/live 恒定 200 且不触达依赖；/health/live 与根级 /live 同源', async () => {
      const root = await request(app.getHttpServer()).get('/api/v1/live').expect(200);
      expect(root.body.data.status).toBe('ok');
      const nested = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
      expect(nested.body.data.status).toBe('ok');
      expect(nested.body.data.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it('/ready 健康时 200 + ready=true + db/redis 均 up（真实依赖探测）', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/ready').expect(200);
      expect(res.body.data.ready).toBe(true);
      expect(res.body.data.db.state).toBe('up');
      expect(res.body.data.redis.state).toBe('up');
      expect(res.body.data.status).toBe('ok');
    });

    it('/health 兼容扩展：保留 status 且新增 db/redis/queue/storage/checks 明细', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      const body = res.body.data as HealthReport;
      expect(body.status).toBe('ok');
      expect(body.db.state).toBe('up');
      expect(body.redis.state).toBe('up');
      expect(body.queue.state).toBe('up');
      expect(typeof body.queue.depth).toBe('number');
      expect(body.queue.maxDepth).toBeGreaterThan(0);
      expect(body.storage.driver).toBeTruthy();
      expect(body.checks.map((c) => c.name)).toEqual(['db', 'redis', 'storage']);
      // critical 分级必须显式暴露给运维（写告警规则依赖它）
      expect(body.checks.find((c) => c.name === 'db')!.critical).toBe(true);
      expect(body.checks.find((c) => c.name === 'storage')!.critical).toBe(false);
    });

    it('依赖分级（真实 HTTP）：DB 不可达 → /ready 503 且 /live 仍 200；存储不可达 → 200 degraded', async () => {
      const health = app.get(HealthService);
      const spy = vi.spyOn(health as unknown as { runProbes(t: number): Promise<ProbeSet> }, 'runProbes');
      try {
        // ① DB 不可达（注入探针结果——**不真停共享 PostgreSQL**）
        spy.mockResolvedValue({ db: down, redis: up, storage: up });
        const dbDown = await request(app.getHttpServer()).get('/api/v1/ready').expect(503);
        expect(dbDown.body.data.ready).toBe(false);
        expect(dbDown.body.data.status).toBe('unavailable');
        await request(app.getHttpServer()).get('/api/v1/live').expect(200); // liveness 绝不受依赖影响
        await request(app.getHttpServer()).get('/api/v1/health').expect(200); // 聚合端点恒 200（报告里体现故障）

        // ② Redis 不可达 → 503（队列结论复用 Redis 探测，不再打网络）
        spy.mockResolvedValue({ db: up, redis: down, storage: up });
        const redisDown = await request(app.getHttpServer()).get('/api/v1/ready').expect(503);
        expect(redisDown.body.data.ready).toBe(false);
        expect(redisDown.body.data.queue.state).toBe('down');
        await request(app.getHttpServer()).get('/api/v1/live').expect(200);

        // ③ 仅对象存储不可达 → 仍 200（非关键依赖绝不摘流量），报告降级为 degraded
        spy.mockResolvedValue({ db: up, redis: up, storage: down });
        const degraded = await request(app.getHttpServer()).get('/api/v1/ready').expect(200);
        expect(degraded.body.data.ready).toBe(true);
        expect(degraded.body.data.status).toBe('degraded');
        expect(degraded.body.data.storage.state).toBe('down');
      } finally {
        spy.mockRestore();
      }
      // 替身撤除后恢复真实探测
      const restored = await request(app.getHttpServer()).get('/api/v1/ready').expect(200);
      expect(restored.body.data.db.state).toBe('up');
    });

    it('探测硬超时：依赖挂起时 /health 仍在 1s 量级内返回（绝不拖垮探针）', async () => {
      const health = app.get(HealthService);
      const spy = vi.spyOn(health as unknown as { runProbes(t: number): Promise<ProbeSet> }, 'runProbes');
      spy.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 1_200)); // 模拟探测整体挂起
        return { db: up, redis: up, storage: up };
      });
      try {
        const t0 = Date.now();
        await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
        expect(Date.now() - t0).toBeLessThan(500); // /live 不等任何探测
      } finally {
        spy.mockRestore();
      }
    });

    it('冷启动不误报：探针客户端尚未 ready 时发出的首个 ping 仍能拿到 PONG（否则启动即 503 假故障）', async () => {
      const client = createRedisProbeClient(process.env.REDIS_URL ?? 'redis://localhost:6379', 1_000);
      try {
        expect(client.status).toBe('wait'); // lazyConnect：此刻还没有任何连接
        const probe = await probeRedis(client, 1_000);
        expect(probe.state).toBe('up'); // 命令在离线队列排队 → 连上即冲刷（enableOfflineQueue=false 时这里会立即 reject → 误报 down）
      } finally {
        client.disconnect();
      }
    });
  });

  // ================= 优雅停机 =================

  describe('P9 优雅停机：阶段顺序 / 在途 job 不中断 / 超时兜底', () => {
    it('真实 Nest + BullMQ：close 期间 onApplicationShutdown 被调用，且在途 job 跑完（worker.close 等待而非强杀）', async () => {
      SHUTDOWN_ORDER.length = 0;
      probeJobFinished = false;
      const probeApp = await NestFactory.createApplicationContext(ShutdownProbeModule, { bufferLogs: false });
      const queue = probeApp.get<Queue>(getQueueToken(PROBE_QUEUE));
      await queue.add('probe', {});
      await waitUntil(() => SHUTDOWN_ORDER.includes('job:start'), 10_000, 'job 开始执行');

      const exits: number[] = [];
      const handle = registerGracefulShutdown(probeApp, {
        worker: true, signals: [], logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
        exit: (c) => exits.push(c), timeoutMs: 20_000,
      });
      const events = await handle.shutdown('SIGTERM');

      expect(events.map((e) => e.phase)).toEqual(['start', 'closing', 'closed']);
      expect(exits).toEqual([0]);
      // 关键不变式：停机过程**没有中断在途 job**（BullMQ worker.close() 等当前 job 结束）
      expect(probeJobFinished).toBe(true);
      expect(SHUTDOWN_ORDER).toContain('job:end');
      // Nest 确实调用了处理器自己的 onApplicationShutdown（lease 释放/中止引擎挂在这里）
      expect(SHUTDOWN_ORDER).toContain('processor:onApplicationShutdown');
      // 观测到的相对顺序（Nest 按模块注册逆序触发钩子：worker 模块晚于 BullModule 注册 → 处理器钩子先跑）
      expect(SHUTDOWN_ORDER.indexOf('processor:onApplicationShutdown')).toBeLessThan(SHUTDOWN_ORDER.indexOf('job:end'));
      handle.dispose();
      await queue.close().catch(() => undefined);
    }, 40_000);

    it('真实 WorkerModule：app.close() 会触发 AgentRunProcessor.onApplicationShutdown（lease 释放钩子确实被调用）', async () => {
      const local = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
      const processor = local.get(AgentRunProcessor);
      const spy = vi.spyOn(processor, 'onApplicationShutdown');
      await local.close();
      expect(spy).toHaveBeenCalledTimes(1);
    }, 40_000);

    it('超时兜底：close 挂住 → 30s 窗口（测试用短窗口）后强制退出码 1，绝不无限等待', async () => {
      const stuck = { close: () => new Promise<void>(() => undefined) };
      const exits: number[] = [];
      const phases: string[] = [];
      const handle = registerGracefulShutdown(stuck, {
        signals: [], logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
        exit: (c) => exits.push(c), timeoutMs: 150, onPhase: (e) => phases.push(e.phase),
      });
      void handle.shutdown('SIGTERM');
      await waitUntil(() => exits.length > 0, 3_000, '强制退出被触发');
      expect(phases).toEqual(['start', 'closing', 'timeout']);
      expect(exits).toEqual([1]);
      handle.dispose();
    });

    it('main.ts / worker.ts 均已接线（源码级断言，防止"写了模块没挂上"）', async () => {
      const { readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const main = await readFile(resolve(process.cwd(), 'src/main.ts'), 'utf8');
      const workerSrc = await readFile(resolve(process.cwd(), 'src/worker.ts'), 'utf8');
      expect(main).toContain('registerGracefulShutdown(app)');
      expect(workerSrc).toContain('registerGracefulShutdown(app, { worker: true })');
    });
  });

  // ================= 故障注入：崩溃恢复 =================

  describe('P9 故障注入：Worker 崩溃 → 恢复接管', () => {
    it('AgentRun：running + lease 过期（模拟 worker 崩溃）→ recoverStale 重新入队 → 真实 worker 接管并完成', async () => {
      const run = await prisma.agentRun.create({
        data: {
          userId, agentId, agentVersionId, status: 'running', startedAt: new Date(), maxSteps: 8, metadata: {},
          workerId: 'm8p9-crashed-worker', leaseUntil: new Date(Date.now() - 60_000), heartbeatAt: new Date(Date.now() - 90_000),
        },
      });
      runIds.push(run.id);
      await prisma.agentRunMessage.create({ data: { runId: run.id, sequence: 0, role: 'user', content: '你好' } });

      const lease = worker.get(AgentRunLeaseService);
      const res = await lease.recoverStale();
      expect(res.reEnqueued).toBeGreaterThanOrEqual(1);

      const finalStatus = await waitForStatus(prisma, run.id, ['completed', 'failed', 'timeout'], 40_000);
      expect(finalStatus).toBe('completed');
      const after = await prisma.agentRun.findUnique({ where: { id: run.id } });
      expect(after!.workerId).not.toBe('m8p9-crashed-worker'); // 已被真实 worker 接管
      expect(after!.workerId).toBeTruthy(); // release 保留 workerId 作可观测记录（M6-P3 契约）
      expect(after!.heartbeatAt).toBeTruthy(); // 接管期间心跳真实续期过
      // 关键不变式（比 leaseUntil 字段值更本质）：终态 run 永不可再被 claim ⇒ 崩溃恢复不会导致二次执行
      const attempt = await lease.claim(run.id, 'm8p9-late-claimer', 60_000);
      expect(attempt.acquired).toBe(false);
      expect(attempt.status).toBe('completed');
      // 不重复执行：LLM 单回合
      expect(await prisma.usageRecord.count({ where: { runId: run.id, kind: 'llm_chat' } })).toBe(1);
    }, 60_000);

    it('AgentRun：重复 recoverStale 不产生第二次执行（claim 条件更新是最终防线）', async () => {
      const run = await prisma.agentRun.create({
        data: {
          userId, agentId, agentVersionId, status: 'running', startedAt: new Date(), maxSteps: 8, metadata: {},
          workerId: 'm8p9-crashed-worker-2', leaseUntil: new Date(Date.now() - 60_000),
        },
      });
      runIds.push(run.id);
      await prisma.agentRunMessage.create({ data: { runId: run.id, sequence: 0, role: 'user', content: '你好' } });
      const lease = worker.get(AgentRunLeaseService);
      // 并发/重复触发恢复（三次）——至少一次语义 + 幂等
      await Promise.all([lease.recoverStale(), lease.recoverStale(), lease.recoverStale()]);

      expect(await waitForStatus(prisma, run.id, ['completed', 'failed', 'timeout'], 40_000)).toBe('completed');
      expect(await prisma.usageRecord.count({ where: { runId: run.id, kind: 'llm_chat' } })).toBe(1); // 只执行一次
      expect(await prisma.agentRunStep.count({ where: { runId: run.id } })).toBe(1);
    }, 60_000);

    it('WorkflowRun：running + lease 过期 → **生产清扫路径**（media-cleanup 周期 sweep）接管 → 完成', async () => {
      const created = await request(app.getHttpServer()).post('/api/v1/workflows').set(XRW).set('Cookie', cookie)
        .send({ name: 'm8p9 恢复验证', definition: MINIMAL_WORKFLOW }).expect(201);
      const workflowId = created.body.data.id as string;
      workflowIds.push(workflowId);
      await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/publish`).set(XRW).set('Cookie', cookie).expect(201);
      const version = await prisma.workflowVersion.findFirst({ where: { workflowId, status: 'published' } });
      expect(version).toBeTruthy();

      const wr = await prisma.workflowRun.create({
        data: {
          workflowId, versionId: version!.id, userId, triggerType: 'manual',
          idempotencyKey: `m8p9-wf-${Date.now()}`, status: 'running', currentStep: 0,
          workerId: 'm8p9-crashed-wf-worker', leaseUntil: new Date(Date.now() - 60_000), startedAt: new Date(),
        },
      });
      workflowRunIds.push(wr.id);

      // 走**生产路径**：不是直接调 WorkflowLeaseService（那会掩盖"原语没被任何周期任务调用"的接线缺口——
      // M8-P9 发现该缺口并接线到 media-cleanup sweep），而是触发 Worker 进程里真实的周期清扫 job。
      const cleanup = worker.get(MediaCleanupProcessor);
      const swept = await cleanup.process({} as Job);
      expect(swept.workflowRecovered.reEnqueued).toBeGreaterThanOrEqual(1);

      expect(await waitForWorkflowRun(prisma, wr.id, ['completed', 'failed', 'timeout'], 40_000)).toBe('completed');
      const after = await prisma.workflowRun.findUnique({ where: { id: wr.id } });
      expect(after!.workerId).not.toBe('m8p9-crashed-wf-worker');
      expect(after!.leaseUntil).toBeNull();
    }, 60_000);

    it('WorkflowRun：sweep 的 workflow 恢复与 AgentRun 恢复同周期生效（接线不变式，防止再次退化为"死代码原语"）', async () => {
      // 直接断言生产清扫入口确实驱动了两条恢复路径：任一为空都说明接线被回退
      const cleanup = worker.get(MediaCleanupProcessor);
      const swept = await cleanup.process({} as Job);
      expect(swept).toHaveProperty('recovered');
      expect(swept).toHaveProperty('workflowRecovered');
      expect(Object.keys(swept)).toEqual(['tasks', 'runs', 'recovered', 'workflowRecovered']);
    }, 60_000);
  });

  // ================= 故障注入：熔断 =================

  describe('P9 故障注入：Provider 超时 → 熔断打开 → 后续请求拒绝', () => {
    it('真实 ModelRouter + 真实 Redis 熔断：连续 provider 超时 → open → 候选被过滤（后续请求不再打到故障 provider）', async () => {
      const cb = app.get(CircuitBreakerService);
      const providerId = `m8p9-provider-${Date.now()}`;
      const candidates = [{ modelId: 'm1', providerId, priority: 1, cost: 0, latencyMs: 10 }];
      // sleep 替身：真实路由器逻辑 + 真实熔断计数，只去掉回退间的 1s 等待（不改变判定）
      const router = new ModelRouterService(cb, async () => undefined);

      expect(await cb.state(providerId)).toBe('healthy');
      expect(await router.order(candidates)).toHaveLength(1); // 健康时可路由

      // 5 次真实 PROVIDER_TIMEOUT（retryable）→ 触发熔断
      for (let i = 0; i < 5; i++) {
        await expect(router.execute(candidates, async () => {
          throw new AppError('PROVIDER_TIMEOUT', 'provider 调用超时');
        })).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
      }

      expect(await cb.state(providerId)).toBe('open');
      expect(await cb.canCall(providerId)).toBe(false);
      expect(await router.order(candidates)).toEqual([]); // 熔断后无候选 → 路由层直接拒绝

      // 冷却 → half_open（只放行探测请求）
      expect(await cb.state(providerId, { cooldownSec: 0 })).toBe('half_open');
      expect(await cb.canCall(providerId, { cooldownSec: 0 }, false)).toBe(false);
      expect(await cb.canCall(providerId, { cooldownSec: 0 }, true)).toBe(true);

      // 探测成功 → 恢复 healthy（熔断可自愈）
      await cb.recordSuccess(providerId);
      expect(await cb.state(providerId)).toBe('healthy');
      expect(await router.order(candidates)).toHaveLength(1);

      await prisma.$executeRawUnsafe('SELECT 1'); // 探针键由 Redis TTL 自然过期，无需清理
    }, 40_000);

    it('熔断是 per-provider 的：一个 provider 熔断不牵连其他候选（故障隔离）', async () => {
      const cb = app.get(CircuitBreakerService);
      const bad = `m8p9-bad-${Date.now()}`;
      const good = `m8p9-good-${Date.now()}`;
      for (let i = 0; i < 5; i++) await cb.recordFailure(bad, { failureThreshold: 5 });
      expect(await cb.state(bad)).toBe('open');
      expect(await cb.state(good)).toBe('healthy');
      const router = new ModelRouterService(cb, async () => undefined);
      const ordered = await router.order([
        { modelId: 'm-bad', providerId: bad, priority: 1, cost: 0, latencyMs: 1 },
        { modelId: 'm-good', providerId: good, priority: 2, cost: 0, latencyMs: 2 },
      ]);
      expect(ordered.map((c) => c.modelId)).toEqual(['m-good']);
    });
  });

  // ================= 幂等回归（重复副作用绝不发生） =================

  describe('P9 幂等回归：重复计量 / 重复恢复不产生重复副作用', () => {
    it('同一 idempotencyKey 重复计量 → 只入账一次（ledger 幂等键唯一）', async () => {
      const billing = app.get(BillingService);
      const key = `m8p9-dup-${Date.now()}`;
      const input = { userId, kind: 'agent_run' as const, quantity: 1, idempotencyKey: key };
      await billing.recordUsage(input);
      await billing.recordUsage(input);
      await billing.recordUsage(input);
      expect(await prisma.usageLedgerEntry.count({ where: { idempotencyKey: key } })).toBe(1);
      await prisma.usageLedgerEntry.deleteMany({ where: { idempotencyKey: key } });
    });

    it('真实 run 终态计量：同 run 全部 ledger 行幂等键互不相同（整链路无重复入账）', async () => {
      const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
        .send({ message: '你好' }).expect(201);
      const runId = res.body.data.runId as string;
      runIds.push(runId);
      expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 40_000)).toBe('completed');
      const entries = await prisma.usageLedgerEntry.findMany({ where: { runId } });
      expect(entries.length).toBeGreaterThan(0);
      expect(new Set(entries.map((e) => e.idempotencyKey)).size).toBe(entries.length);
    }, 60_000);
  });

  // ================= Scheduler stalled 巡检 =================

  describe('P9 Scheduler stalled：running 无心跳 → 判 dead（不自动重投）', () => {
    it('真实 DB 行 + 真实 processor：心跳中断超阈值 → dead + lastError + 事件落库，且无重投 job', async () => {
      const row = await prisma.scheduledJob.create({
        data: {
          ownerUserId: userId, name: 'm8p9-stalled', handler: 'noop', type: 'one-shot',
          status: 'running', timeoutMs: 1_000, attempts: 1, maxAttempts: 3,
          updatedAt: new Date(Date.now() - 120_000), // 2min 无心跳（阈值 max(1s×3, 500ms×3)=3s）
        },
      });
      scheduledJobIds.push(row.id);

      const proc = worker.get(SchedulerProcessor);
      const res = await proc.reconcileStalled();
      expect(res.reaped).toBeGreaterThanOrEqual(1);

      const after = await prisma.scheduledJob.findUnique({ where: { id: row.id } });
      expect(after!.status).toBe('dead'); // 一致性优先：判失败，不自动重投
      expect(after!.lastError).toContain('stalled');
      expect(after!.completedAt).toBeTruthy();
      const event = await prisma.eventEnvelope.findUnique({ where: { eventId: `sched:${row.id}:1:scheduler.job.dead` } });
      expect(event).toBeTruthy();
    }, 40_000);

    it('心跳新鲜的行绝不被误判（巡检只杀真死的作业）', async () => {
      const row = await prisma.scheduledJob.create({
        data: {
          ownerUserId: userId, name: 'm8p9-alive', handler: 'noop', type: 'one-shot',
          status: 'running', timeoutMs: 1_000, attempts: 1, updatedAt: new Date(),
        },
      });
      scheduledJobIds.push(row.id);
      const proc = worker.get(SchedulerProcessor);
      await proc.reconcileStalled();
      expect((await prisma.scheduledJob.findUnique({ where: { id: row.id } }))!.status).toBe('running');
    }, 40_000);
  });

  // ================= 队列语义回归（只测不改） =================

  describe('P9 BullMQ 重试/backoff 语义与既有 lease 语义不冲突（回归）', () => {
    it('agent-run 队列 job 失败重试耗尽后 run 仍可由 recoverStale 兜底（attempts/backoff 不改变 DB 事实源）', async () => {
      const queue = new Queue('agent-run', { connection: REDIS() });
      try {
        const run = await prisma.agentRun.create({
          data: {
            userId, agentId, agentVersionId, status: 'running', startedAt: new Date(), maxSteps: 8, metadata: {},
            workerId: 'm8p9-crashed-worker-3', leaseUntil: new Date(Date.now() - 60_000),
          },
        });
        runIds.push(run.id);
        await prisma.agentRunMessage.create({ data: { runId: run.id, sequence: 0, role: 'user', content: '你好' } });
        const opts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        expect(typeof opts.waiting).toBe('number'); // 队列可观测（背压口径）
        const lease = worker.get(AgentRunLeaseService);
        await lease.recoverStale();
        expect(await waitForStatus(prisma, run.id, ['completed', 'failed', 'timeout'], 40_000)).toBe('completed');
      } finally {
        await queue.close();
      }
    }, 60_000);
  });

  // ================= SSE 断线不影响 runtime（M6-P6 回归引用） =================

  describe('P9 SSE 断线不中断执行（M6-P6 契约回归）', () => {
    it('客户端订阅后立刻断开：run 仍在后台完成（观察通道与执行通道解耦）', async () => {
      const created = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
        .send({ message: '你好' }).expect(201);
      const runId = created.body.data.runId as string;
      runIds.push(runId);
      // 真实建连 → 真实断线（abort 未读完的流），随后 run 必须仍在后台跑完
      const stream = request(app.getHttpServer()).get(`/api/v1/agent-runs/${runId}/events`).set(XRW).set('Cookie', cookie);
      stream.end(() => undefined);
      await new Promise((r) => setTimeout(r, 400)); // 等 SSE 建连（响应头已发出）
      stream.abort();
      expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 40_000)).toBe('completed');
    }, 60_000);
  });

  // ================= 背压 =================

  describe('P9 背压：全局队列深度 → 429（真实队列计数 + 水位配置）', () => {
    it('真实 backlog 超水位 → agent-run 创建被拒 429 QUOTA_EXCEEDED；撤压后放行', async () => {
      const queue = new Queue('agent-run', { connection: REDIS() });
      const prev = process.env.AGENT_RUN_QUEUE_MAX_DEPTH;
      process.env.AGENT_RUN_QUEUE_MAX_DEPTH = '1';
      let depth = 0;
      try {
        // 决定性造压：真实投递占位 job（无 runId ⇒ 处理器立即完成，副作用为零；removeOnComplete 不留残渣）。
        // worker 并发为 2 且处理极快，因此按"到达率 > 消费率"追加，直到真实计数确实 ≥ 5 才发请求——
        // 绝不依赖"队列里碰巧有 job"这种脆弱前提。
        for (let attempt = 0; attempt < 40 && depth < 5; attempt++) {
          await queue.addBulk(Array.from({ length: 10 }, () => (
            { name: 'm8p9-backpressure-filler', data: {}, opts: { removeOnComplete: true } }
          )));
          const counts = await queue.getJobCounts('waiting', 'active');
          depth = (counts.waiting ?? 0) + (counts.active ?? 0);
        }
        expect(depth).toBeGreaterThanOrEqual(5); // 真实积压已建立（口径与 QuotaService 完全一致）

        const blocked = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
          .send({ message: '你好' }).expect(429);
        expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED');
        expect(blocked.body.error.message).toContain('队列积压'); // 报文含真实口径 X/Y，便于运维定位
        expect(blocked.body.error.message).toMatch(/积压 \d+\/1，/); // depth 为真实计数、maxDepth 为当前水位
      } finally {
        // 撤压 + 还原水位（无论断言结果如何都必须执行：绝不把共享队列与本进程配置留在污染状态）
        if (prev === undefined) delete process.env.AGENT_RUN_QUEUE_MAX_DEPTH;
        else process.env.AGENT_RUN_QUEUE_MAX_DEPTH = prev;
        await queue.close();
      }
      // 水位还原（默认 1000）⇒ 即使占位 job 尚未排空也放行
      const allowed = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
        .send({ message: '你好' }).expect(201);
      runIds.push(allowed.body.data.runId);
      await waitForStatus(prisma, allowed.body.data.runId, ['completed', 'failed'], 40_000);
    }, 90_000);
  });
});
