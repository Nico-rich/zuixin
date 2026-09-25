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

/**
 * M8-P2 Billing / Subscription / Quota e2e（真实 PostgreSQL/Redis/Worker）：
 * 计划/订阅（mock 计费）/用量计量（复用 UsageRecord 归因 + ledger 幂等）/
 * 配额三态（月度耗尽 QUOTA_EXCEEDED）/发票/重复支付事件幂等/RBAC。
 */
describe('M8-P2 Billing / Subscription / Quota (e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let userId = '';
  let orgId = '';
  let tinyPlanId = '';
  let tinyConcurrentPlanId = '';
  const runIds: string[] = [];
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

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id;
    const org = await prisma.organization.findFirst({ where: { ownerUserId: userId, isPersonal: true } });
    orgId = org!.id;
    // 独立计量基线：清空该组织历史 ledger（全量套件其他 spec 的 run 也归集于此——配额测试需要确定性起点）
    await prisma.usageLedgerEntry.deleteMany({ where: { organizationId: orgId } });
    // Pre-M9 C1：同样清空该组织历史配额预留（其他 spec 的 run 预留残留会污染消耗计数）
    await prisma.quotaReservation.deleteMany({ where: { organizationId: orgId } });

    // 极小额度计划（配额测试专用）：月度 2 + 并发 1
    const tiny = await prisma.plan.create({
      data: {
        code: `tiny-${Date.now()}`, name: 'Tiny Test', monthlyPrice: 1, yearlyPrice: 10, active: true,
        entitlements: {
          agentRunsMonthly: 2, agentRunsDaily: 100, concurrentAgentRuns: 1,
          workflowRunsMonthly: 100, concurrentWorkflowRuns: 100,
          llmTokensMonthly: 1_000_000_000, imageMonthly: 1_000_000,
          videoSecondsMonthly: 1_000_000, externalApiMonthly: 1_000_000,
          storageMb: 100_000, seats: 100,
        } as never,
      },
    });
    tinyPlanId = tiny.id;
    // 并发专用计划（月度宽裕 + 并发 1）
    const tinyConcurrent = await prisma.plan.create({
      data: {
        code: `tinyc-${Date.now()}`, name: 'Tiny Concurrent', monthlyPrice: 1, yearlyPrice: 10, active: true,
        entitlements: {
          agentRunsMonthly: 1000, agentRunsDaily: 1000, concurrentAgentRuns: 1,
          workflowRunsMonthly: 100, concurrentWorkflowRuns: 100,
          llmTokensMonthly: 1_000_000_000, imageMonthly: 1_000_000,
          videoSecondsMonthly: 1_000_000, externalApiMonthly: 1_000_000,
          storageMb: 100_000, seats: 100,
        } as never,
      },
    });
    tinyConcurrentPlanId = tinyConcurrent.id;

    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
    const { Queue } = await import('bullmq');
    imageQueue = new Queue('image', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null } });
  });

  afterAll(async () => {
    await imageQueue?.resume().catch(() => undefined);
    await imageQueue?.close().catch(() => undefined);
    if (runIds.length) {
      await prisma.generationTask.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.artifact.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.usageRecord.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } });
    }
    await prisma.usageLedgerEntry.deleteMany({ where: { organizationId: orgId } });
    await prisma.paymentEvent.deleteMany({ where: { organizationId: orgId } });
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } });
    await prisma.subscription.deleteMany({ where: { organizationId: orgId } });
    if (tinyPlanId) await prisma.plan.delete({ where: { id: tinyPlanId } }).catch(() => undefined);
    if (tinyConcurrentPlanId) await prisma.plan.delete({ where: { id: tinyConcurrentPlanId } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  it('P2 计划/订阅：plans 种子 4 档；缺省 free 订阅；升级到 pro（mock 计费：发票 paid + 支付事件）', async () => {
    const plans = await request(app.getHttpServer()).get('/api/v1/billing/plans').set(XRW).set('Cookie', cookie).expect(200);
    expect((plans.body.data as Array<{ code: string }>).map((p) => p.code)).toEqual(expect.arrayContaining(['free', 'pro', 'team', 'enterprise']));

    const sub = await request(app.getHttpServer()).get(`/api/v1/billing/subscription?organizationId=${orgId}`).set(XRW).set('Cookie', cookie).expect(200);
    expect(sub.body.data.plan).toBe('free');

    const pro = (plans.body.data as Array<{ id: string; code: string }>).find((p) => p.code === 'pro')!;
    const upgraded = await request(app.getHttpServer()).post('/api/v1/billing/subscribe').set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgId, planId: pro.id }).expect(201);
    expect(upgraded.body.data).toMatchObject({ plan: 'pro', status: 'active', invoice: { status: 'paid' } });
    const invoices = await request(app.getHttpServer()).get(`/api/v1/billing/invoices?organizationId=${orgId}`).set(XRW).set('Cookie', cookie).expect(200);
    expect((invoices.body.data as Array<{ status: string }>)[0].status).toBe('paid');
  });

  it('P2 用量计量：agent run 终态 → ledger（agent_run + llm_tokens + llm_cost，幂等键=run id）+ usage 聚合', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' }).expect(201);
    const runId = res.body.data.runId as string;
    runIds.push(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');

    const entries = await prisma.usageLedgerEntry.findMany({ where: { runId } });
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain('agent_run');
    expect(kinds).toContain('llm_tokens');
    expect(kinds).toContain('llm_cost');
    // 幂等键 = run id（绝不重复计量）
    expect(new Set(entries.map((e) => e.idempotencyKey)).size).toBe(entries.length);

    const usage = await request(app.getHttpServer()).get(`/api/v1/billing/usage?organizationId=${orgId}`).set(XRW).set('Cookie', cookie).expect(200);
    expect(usage.body.data.facts.agent_run).toBeGreaterThanOrEqual(1);
    expect(usage.body.data.facts).toHaveProperty('llm_tokens'); // mock LLM tokens=0（引擎不计量 token），条目存在即可
    expect(usage.body.data.facts).toHaveProperty('llm_cost');
    expect(usage.body.data.layering.facts).toBe('ledger-aggregate');
  });

  it('P2 配额耗尽：tiny 计划（agentRunsMonthly=2）→ 第 3 个 run 创建 429 QUOTA_EXCEEDED', async () => {
    // 切到 tiny 计划（billing.write = owner）
    await request(app.getHttpServer()).post('/api/v1/billing/subscribe').set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgId, planId: tinyPlanId }).expect(201);
    // 先跑满 2 个（月度已消费 1 个——上一条测试；再补 1 个）
    const fill = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' }).expect(201);
    runIds.push(fill.body.data.runId);
    await waitForStatus(prisma, fill.body.data.runId, ['completed', 'failed'], 30_000);

    // 第 3 个 → 429（服务端裁决，LLM 不参与）
    const blocked = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' }).expect(429);
    expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED');
  });

  it('P2 并发配额：concurrentAgentRuns=1 → 活跃 run 期间新 run 429；结束后放行', async () => {
    // 切到并发专用计划（月度宽裕，只测并发维度）
    await request(app.getHttpServer()).post('/api/v1/billing/subscribe').set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgId, planId: tinyConcurrentPlanId }).expect(201);
    await imageQueue.pause(); // 确定性活跃 run（image 任务 pending → run waiting）
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '画一张黑金配色主图' }).expect(201);
    const activeId = res.body.data.runId as string;
    runIds.push(activeId);
    await waitForStatus(prisma, activeId, ['waiting'], 25_000);

    const blocked = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' }).expect(429);
    expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED');

    await imageQueue.resume();
    await waitForStatus(prisma, activeId, ['completed', 'failed'], 30_000);
    const after = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' }).expect(201);
    runIds.push(after.body.data.runId);
    await waitForStatus(prisma, after.body.data.runId, ['completed', 'failed'], 30_000);
  });

  it('P2 重复支付事件幂等 + RBAC：member billing.read 可读 / billing.write 403', async () => {
    // 服务级幂等（mock 支付事件重复投递）
    const { BillingService } = await import('../src/modules/billing/billing.service');
    const billing = app.get(BillingService);
    const invoice = await prisma.invoice.create({
      data: { organizationId: orgId, number: `INV-DUP-${Date.now()}`, status: 'open', amount: 9.9, periodStart: new Date(), periodEnd: new Date() },
    });
    const first = await billing.applyPayment(orgId, invoice.id, 9.9);
    const second = await billing.applyPayment(orgId, invoice.id, 9.9);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(await prisma.paymentEvent.count({ where: { invoiceId: invoice.id } })).toBe(1); // 绝不重复入账
    await prisma.invoice.delete({ where: { id: invoice.id } });

    // RBAC：member 可读 billing、不可 subscribe（billing.write = owner）
    const member = await prisma.user.create({ data: { email: `billingm-${Date.now()}@example.com`, passwordHash: 'unused-hash' } });
    await prisma.organizationMember.create({ data: { organizationId: orgId, userId: member.id, role: 'member' } });
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = app.get(JwtService);
    const cookieM = `agent_access=${await jwt.signAsync({ sub: member.id, role: 'user' })}`;
    await request(app.getHttpServer()).get(`/api/v1/billing/usage?organizationId=${orgId}`).set(XRW).set('Cookie', cookieM).expect(200);
    const pro = await prisma.plan.findUnique({ where: { code: 'pro' } });
    await request(app.getHttpServer()).post('/api/v1/billing/subscribe').set(XRW).set('Cookie', cookieM)
      .send({ organizationId: orgId, planId: pro!.id }).expect(403);
    await prisma.organizationMember.deleteMany({ where: { organizationId: orgId, userId: member.id } });
    await prisma.user.delete({ where: { id: member.id } });
  });
});
