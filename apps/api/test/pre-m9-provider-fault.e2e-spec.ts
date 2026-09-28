import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { CircuitBreakerService } from '../src/core/circuit-breaker/circuit-breaker.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const MOCK_PROVIDER_ID = 'seed-llm-mock';

async function waitForStatus(prisma: PrismaService, runId: string, targets: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const row = await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true, errorCode: true } });
    if (!row || targets.includes(row.status)) return row ? `${row.status}:${row.errorCode ?? ''}` : 'missing';
    last = row.status;
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

/**
 * Pre-M9 测试补强：Provider 故障注入（G6 流式四层超时 / G2 引擎失败→熔断计数→open→跳过→PROVIDER_UNAVAILABLE）。
 * 隔离：独立 Redis DB 3（熔断器为 Redis 支撑——绝不污染共享 DB 0 上的其他套件状态）；
 * 每个场景独立 app+worker（adapter 在启动时按 env 构造——故障模式必须启动前注入）。
 */
describe('Pre-M9 Provider Fault Injection (e2e, 真实 Queue + Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let userId = '';
  const runIds: string[] = [];

  async function boot(): Promise<void> {
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
    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  }

  async function login(): Promise<void> {
    const stamp = Date.now();
    const user = await prisma.user.create({ data: { email: `prem9-fault-${stamp}@example.com`, passwordHash: 'unused-hash' } });
    userId = user.id;
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = app.get(JwtService);
    cookie = `agent_access=${await jwt.signAsync({ sub: user.id, role: 'user' })}`;
  }

  async function createRun(message: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message }).expect(201);
    const runId = res.body.data.runId as string;
    runIds.push(runId);
    return runId;
  }

  async function teardown(): Promise<void> {
    // 复位熔断器状态（Redis 键）——绝不把 open 状态泄漏给下一个场景
    try { await app.get(CircuitBreakerService).recordSuccess(MOCK_PROVIDER_ID); } catch { /* 无 app 时忽略 */ }
    await prisma.agentRunMessage.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
    await prisma.usageRecord.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.usageLedgerEntry.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.quotaReservation.deleteMany({ where: { organizationId: { startsWith: 'personal-' } } }).catch(() => undefined);
    await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => undefined);
    await prisma.conversation.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { ownerUserId: userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app.close();
    runIds.length = 0;
  }

  afterAll(async () => { /* 各场景自清理 */ });

  describe('G6 stall：流静默 → idle 超时 → PROVIDER_TIMEOUT（绝不挂住）', () => {
    beforeAll(async () => {
      process.env.REDIS_URL = 'redis://localhost:6379/3'; // 独立 DB：熔断/队列绝不污染共享 DB 0
      process.env.MOCK_LLM_FAILURE = 'stall';
      process.env.MOCK_LLM_STALL_MS = '5000';        // 静默 5s（远超 idle 上限）
      process.env.LLM_STREAM_IDLE_TIMEOUT_MS = '1500'; // idle 1.5s
      process.env.LLM_RETRY_BACKOFF_MS = '1,2';        // 重试退避近零（测试确定性）
      await boot();
      await login();
    });
    afterAll(async () => {
      delete process.env.MOCK_LLM_FAILURE; delete process.env.MOCK_LLM_STALL_MS;
      delete process.env.LLM_STREAM_IDLE_TIMEOUT_MS; delete process.env.LLM_RETRY_BACKOFF_MS;
      await teardown();
    });

    it('stall 流（发块后静默）→ 三次尝试全部 idle 超时 → run failed(PROVIDER_TIMEOUT)，绝无挂住', async () => {
      const runId = await createRun('你好');
      const final = await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000);
      expect(final).toBe('failed:PROVIDER_TIMEOUT');
    }, 45_000);
  });

  describe('G2 timeout：连续失败 → 熔断计数 → open → 无候选 → PROVIDER_UNAVAILABLE', () => {
    beforeAll(async () => {
      process.env.REDIS_URL = 'redis://localhost:6379/3'; // 独立 DB
      process.env.MOCK_LLM_FAILURE = 'timeout';
      process.env.LLM_RETRY_BACKOFF_MS = '1,2';
      await boot();
      await login();
    });
    afterAll(async () => {
      delete process.env.MOCK_LLM_FAILURE; delete process.env.LLM_RETRY_BACKOFF_MS;
      await teardown();
    });

    it('5 个失败 run（回合粒度计数）→ 熔断 open → 第 6 个 run 跳过故障 provider 回退健康模型（fallback 语义 + 归因正确）', async () => {
      // 引擎熔断计数为回合粒度（每 run 1 次失败）——5 个失败 run 达阈值
      for (let i = 0; i < 5; i++) {
        const runId = await createRun('你好');
        expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('failed:PROVIDER_TIMEOUT');
      }
      // 5 次失败 = 阈值 → open（app 与 worker 同源视图——同一 Redis DB）
      const cb = app.get(CircuitBreakerService);
      const cbWorker = worker.get(CircuitBreakerService);
      expect(await cb.state(MOCK_PROVIDER_ID)).toBe('open');
      expect(await cbWorker.state(MOCK_PROVIDER_ID)).toBe('open');

      // mock-echo（default，被熔断）被跳过 → 回退到健康的 mock-router 模型 → run 完成
      const runId = await createRun('你好');
      expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed:');
      // 归因正确：第 6 个 run 的 usage 全部落在回退目标 provider（绝非故障 provider）
      const usage = await prisma.usageRecord.findMany({ where: { runId, status: 'success' } });
      expect(usage.length).toBeGreaterThan(0);
      expect(usage.every((u) => u.providerId === 'seed-llm-mock-router')).toBe(true);
    }, 90_000);
  });

  describe('G2 unavailable：不可恢复错误 → 不重试 → run failed（usage 失败归因）', () => {
    beforeAll(async () => {
      process.env.REDIS_URL = 'redis://localhost:6379/3'; // 独立 DB
      process.env.MOCK_LLM_FAILURE = 'unavailable';
      process.env.LLM_RETRY_BACKOFF_MS = '1,2';
      await boot();
      await login();
    });
    afterAll(async () => {
      delete process.env.MOCK_LLM_FAILURE; delete process.env.LLM_RETRY_BACKOFF_MS;
      await teardown();
    });

    it('unavailable → 单次尝试失败（映射 provider 错误，绝不重试）→ usage 失败行', async () => {
      const runId = await createRun('你好');
      const final = await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000);
      expect(final.startsWith('failed:')).toBe(true);
      const usage = await prisma.usageRecord.findFirst({ where: { runId, status: 'failed' } });
      expect(usage).toBeTruthy(); // 失败回合也有 usage 归因（R1 语义）
    }, 45_000);
  });
});
