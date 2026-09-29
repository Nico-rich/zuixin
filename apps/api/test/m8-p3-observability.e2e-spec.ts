import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { TracingMiddleware } from '../src/core/tracing/tracing.middleware';
import { maskEmail } from '../src/modules/audit/audit.service';
import { PrismaService } from '../src/modules/prisma/prisma.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

async function waitUntil<T>(probe: () => Promise<T>, ok: (value: T) => boolean, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await probe();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  throw new Error(`等待超时（${label}）`);
}

/**
 * M8-P3 Observability / Audit e2e（真实 PostgreSQL/Redis/Worker）：
 * HTTP 追踪传播（响应头/X-Trace-Id 继承）→ 指标采样（request/error/agent_run_duration/queue_depth）→
 * login 审计（成功+失败；邮箱掩码、绝不落密码、trace 字段自动注入）→ metrics API 的认证与租户隔离。
 */
describe('M8-P3 Observability / Audit (e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let redis: Redis;
  let cookie = '';
  let cookieB = '';
  let userId = '';
  let userB = '';
  let orgId = ''; // admin 的个人组织
  let suiteStartedAt: Date;
  const runIds: string[] = [];
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123456';

  beforeAll(async () => {
    process.env.MOCK_DELAY_MS = '0';
    suiteStartedAt = new Date();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    // 与 main.ts 同序：追踪中间件先于 csrf 注册（须在 init 注册路由之前，否则不会进入 express 中间件链）
    app.use(moduleRef.get(TracingMiddleware).handler);
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
    await app.listen(0);
    prisma = moduleRef.get(PrismaService);

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).send({ email, password }).expect(201);
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id as string;
    const org = await prisma.organization.findFirst({ where: { ownerUserId: userId, isPersonal: true } });
    orgId = org!.id;

    // B：无任何组织成员身份的独立用户（跨租户/跨用户隔离验证）
    const b = await prisma.user.create({ data: { email: `m8p3-b-${Date.now()}@example.com`, passwordHash: 'unused-hash' } });
    userB = b.id;
    const jwtB = app.get((await import('@nestjs/jwt')).JwtService);
    cookieB = `agent_access=${await jwtB.signAsync({ sub: userB, role: 'user' })}`;

    // Worker 上下文（真实消费 agent-run 队列；队列深度采样随 onModuleInit 立即执行一轮）
    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  });

  afterAll(async () => {
    if (runIds.length) {
      await prisma.usageRecord.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
      await prisma.usageLedgerEntry.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
      await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => undefined);
    }
    // 本套件窗口内的观测样本（append-only，仅清理自己产生的，避免污染后续套件的视图）
    await prisma.metricSample.deleteMany({ where: { sampledAt: { gte: suiteStartedAt } } }).catch(() => undefined);
    if (userB) await prisma.user.delete({ where: { id: userB } }).catch(() => undefined);
    redis?.disconnect();
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  it('P3 HTTP 传播：响应头回写 X-Request-Id/X-Trace-Id；客户端 X-Trace-Id 被继承（跨服务关联）', async () => {
    const auto = await request(app.getHttpServer()).get('/api/v1/health').set(XRW).expect(200);
    expect(auto.headers['x-request-id']).toMatch(UUID_RE);
    expect(auto.headers['x-trace-id']).toMatch(UUID_RE);

    const inherited = await request(app.getHttpServer()).get('/api/v1/health')
      .set(XRW).set('X-Trace-Id', 'trace-from-upstream').set('X-Request-Id', 'req-from-upstream').expect(200);
    expect(inherited.headers['x-trace-id']).toBe('trace-from-upstream');
    expect(inherited.headers['x-request-id']).toBe('req-from-upstream');
  });

  it('P3 HTTP 指标：request_count/request_latency_ms 采样写入（含 method/path/status 标签）', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').set(XRW).expect(200);
    const rows = await waitUntil(
      () => prisma.metricSample.findMany({ where: { name: 'request_count', sampledAt: { gte: suiteStartedAt } }, orderBy: { sampledAt: 'desc' }, take: 5 }),
      (r) => r.length > 0, 10_000, 'request_count 样本',
    );
    expect(rows[0].unit).toBe('count');
    expect(rows[0].value).toBe(1);
    expect(rows[0].labels).toMatchObject({ method: 'GET' });
    expect((rows[0].labels as { path?: string }).path).toBeTruthy();

    const latency = await waitUntil(
      () => prisma.metricSample.findMany({ where: { name: 'request_latency_ms', sampledAt: { gte: suiteStartedAt } }, take: 5 }),
      (r) => r.length > 0, 10_000, 'request_latency_ms 样本',
    );
    expect(latency[0].unit).toBe('ms');
    expect(latency[0].value).toBeGreaterThanOrEqual(0);
  });

  it('P3 Worker 指标：agent run 完成后存在 agent_run_duration_ms 采样（runId/userId/组织归属齐备）', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' }).expect(201);
    const runId = res.body.data.runId as string;
    runIds.push(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');

    const sample = await waitUntil(
      () => prisma.metricSample.findFirst({
        where: { name: 'agent_run_duration_ms', labels: { path: ['runId'], equals: runId } },
        orderBy: { sampledAt: 'desc' },
      }),
      (s) => s !== null, 15_000, 'agent_run_duration_ms 样本',
    );
    expect(sample!.unit).toBe('ms');
    expect(sample!.value).toBeGreaterThanOrEqual(0);
    expect(sample!.organizationId).toBe(orgId); // AgentRun 无 organizationId 列 → 个人组织兜底
    expect(sample!.labels).toMatchObject({ runId, userId, outcome: 'finished' });
  });

  it('P3 队列深度：Worker 启动即采样 image/video/agent-run/workflow 四队列', async () => {
    const rows = await waitUntil(
      () => prisma.metricSample.findMany({ where: { name: 'queue_depth', sampledAt: { gte: suiteStartedAt } } }),
      // M11 集成修复（P8 报告）：多 worker 并发时共享库内会交错写入多轮样本（同队列多行），
      // 原"恰 4 行"断言是共享库全局断言——改为"四队列集合齐备"（去重后恰好覆盖，多余行容忍）
      (r) => new Set(r.map((x) => (x.labels as { queue?: string }).queue)).size >= 4, 15_000, 'queue_depth 样本',
    );
    const queues = [...new Set(rows.map((r) => (r.labels as { queue?: string }).queue))].sort();
    expect(queues).toEqual(['agent-run', 'image', 'video', 'workflow']);
    for (const row of rows) {
      expect(row.unit).toBe('count');
      expect(row.value).toBeGreaterThanOrEqual(0);
    }
  });

  it('P3 login 审计：成功/失败都留痕；metadata 仅邮箱掩码、绝不含明文密码；requestId/traceId 自动注入', async () => {
    const before = new Date();
    await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).send({ email, password }).expect(201);
    const ok = await waitUntil(
      () => prisma.auditLog.findFirst({ where: { userId, action: 'auth.login', createdAt: { gte: before } }, orderBy: { createdAt: 'desc' } }),
      (r) => r !== null, 10_000, 'auth.login 审计',
    );
    expect(ok!.result).toBe('success');
    expect(ok!.organizationId).toBe(orgId);
    expect(ok!.actorId).toBe(userId);
    expect(ok!.requestId).toBeTruthy(); // HTTP 追踪上下文自动注入
    expect(ok!.traceId).toBeTruthy();
    expect((ok!.metadata as { email?: string }).email).toBe(maskEmail(email));
    expect((ok!.metadata as { email?: string }).email).not.toBe(email);
    expect(JSON.stringify(ok)).not.toContain(password); // 绝不落明文密码

    const beforeFail = new Date();
    await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).send({ email, password: 'definitely-wrong-pass' }).expect(401);
    const failed = await waitUntil(
      () => prisma.auditLog.findFirst({ where: { userId, action: 'auth.login_failed', createdAt: { gte: beforeFail } }, orderBy: { createdAt: 'desc' } }),
      (r) => r !== null, 10_000, 'auth.login_failed 审计',
    );
    expect(failed!.result).toBe('denied');
    expect((failed!.metadata as { email?: string }).email).toBe(maskEmail(email));
    expect(JSON.stringify(failed)).not.toContain('definitely-wrong-pass');

    // 清理登录失败计数（本套件不应干扰其他套件的登录）
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', 'auth:loginfail:*', 'COUNT', 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (keys.length) await redis.del(...keys);
  });

  it('P3 metrics API：匿名 401；他人 organizationId 403；本人 200（组织样本 ∪ 本人样本）；跨用户样本不可见', async () => {
    // 匿名 → 401；该请求同时产生 error_count 样本（status≥400）
    await request(app.getHttpServer()).get('/api/v1/metrics').set(XRW).expect(401);
    await waitUntil(
      () => prisma.metricSample.findMany({ where: { name: 'error_count', sampledAt: { gte: suiteStartedAt } }, take: 5 }),
      (r) => r.length > 0, 10_000, 'error_count 样本',
    );

    // 他人组织 → 403（非成员；不泄露组织数据）
    await request(app.getHttpServer()).get(`/api/v1/metrics?organizationId=${orgId}`).set(XRW).set('Cookie', cookieB).expect(403);

    // 本人组织 → 200（组织归属样本）
    const ownOrg = await request(app.getHttpServer())
      .get(`/api/v1/metrics?organizationId=${orgId}&name=agent_run_duration_ms`).set(XRW).set('Cookie', cookie).expect(200);
    expect((ownOrg.body.data as Array<{ name: string }>).some((s) => s.name === 'agent_run_duration_ms')).toBe(true);

    // 本人（不带组织）→ 200：request_count 样本存在 + limit 生效
    const own = await request(app.getHttpServer()).get('/api/v1/metrics?name=request_count&limit=2').set(XRW).set('Cookie', cookie).expect(200);
    const ownRows = own.body.data as Array<{ name: string; labels: { userId?: string } }>;
    expect(ownRows.length).toBeGreaterThan(0);
    expect(ownRows.length).toBeLessThanOrEqual(2);
    expect(ownRows.every((s) => s.name === 'request_count' && s.labels?.userId === userId)).toBe(true);

    // 跨用户隔离：B 查不到 A 的 run 指标
    const bView = await request(app.getHttpServer()).get('/api/v1/metrics?name=agent_run_duration_ms').set(XRW).set('Cookie', cookieB).expect(200);
    expect(bView.body.data).toEqual([]);
  });
});
