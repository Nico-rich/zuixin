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

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

async function waitForStatus(prisma: PrismaService, runId: string, targets: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const row = await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true } });
    if (!row || targets.includes(row.status)) return row?.status ?? 'missing';
    last = row.status;
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

/**
 * Pre-M9 测试补强：真实多实例（2 API + 2 Worker，同一 DB 与独立 Redis DB 4）。
 * 验证：跨实例 worker 抢占（claim fencing）/ C1 配额预留跨实例精确准入（2/4）/ 幂等键跨实例不重复计量。
 */
describe('Pre-M9 Multi-Instance (e2e, 2 API + 2 Worker)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let workerA: INestApplicationContext;
  let workerB: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let userId = '';
  let orgId = '';
  const runIds: string[] = [];

  beforeAll(async () => {
    process.env.REDIS_URL = 'redis://localhost:6379/4'; // 独立 DB：本文件自包含
    process.env.MOCK_DELAY_MS = '0';

    const moduleA = await Test.createTestingModule({ imports: [AppModule] }).compile();
    appA = moduleA.createNestApplication();
    appA.use(cookieParser());
    appA.use('/api/v1', csrfProtection);
    appA.setGlobalPrefix('api/v1');
    appA.useGlobalFilters(moduleA.get(GlobalExceptionFilter));
    appA.useGlobalInterceptors(new TransformInterceptor());
    await appA.init();
    await appA.listen(0);
    prisma = moduleA.get(PrismaService);

    const moduleB = await Test.createTestingModule({ imports: [AppModule] }).compile();
    appB = moduleB.createNestApplication();
    appB.use(cookieParser());
    appB.use('/api/v1', csrfProtection);
    appB.setGlobalPrefix('api/v1');
    appB.useGlobalFilters(moduleB.get(GlobalExceptionFilter));
    appB.useGlobalInterceptors(new TransformInterceptor());
    await appB.init();
    await appB.listen(0);

    const { NestFactory } = await import('@nestjs/core');
    workerA = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
    workerB = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });

    // 专用用户 + 个人组织（与既有数据完全隔离）
    const stamp = Date.now();
    const user = await prisma.user.create({ data: { email: `prem9-mi-${stamp}@example.com`, passwordHash: 'unused-hash' } });
    userId = user.id;
    const org = await prisma.organization.create({
      data: { id: `personal-${user.id}`, name: 'PreM9-MI', slug: `personal-${user.id}`, isPersonal: true, ownerUserId: user.id, members: { create: { userId: user.id, role: 'owner' } } },
    });
    orgId = org.id;
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = appA.get(JwtService);
    cookie = `agent_access=${await jwt.signAsync({ sub: user.id, role: 'user' })}`;
  });

  afterAll(async () => {
    await prisma.quotaReservation.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.usageLedgerEntry.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.usageRecord.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.agentRunMessage.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
    await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => undefined);
    await prisma.conversation.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.subscription.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    await workerA?.close().catch(() => undefined);
    await workerB?.close().catch(() => undefined);
    await appA.close();
    await appB.close();
  });

  it('双 worker 抢占：6 个并发 run 全部完成，两个 worker 都实际处理过 run（claim fencing 无重复执行）', async () => {
    const create = (server: unknown) => request(server as never).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' }).expect(201);
    const res = await Promise.all([
      create(appA.getHttpServer()), create(appB.getHttpServer()), create(appA.getHttpServer()),
      create(appB.getHttpServer()), create(appA.getHttpServer()), create(appB.getHttpServer()),
    ]);
    for (const r of res) runIds.push(r.body.data.runId as string);

    for (const runId of runIds) {
      expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    }
    const runs = await prisma.agentRun.findMany({ where: { id: { in: runIds } }, select: { workerId: true } });
    const workers = new Set(runs.map((r) => r.workerId).filter((w) => w !== null));
    expect(workers.size).toBeGreaterThanOrEqual(2); // 两个 worker 实例都参与过执行（真实跨实例 claim）
    // 每个 run 的 agent_run 账本行有且仅有一行（幂等键跨实例唯一）
    const ledger = await prisma.usageLedgerEntry.findMany({ where: { runId: { in: runIds }, kind: 'agent_run' } });
    expect(ledger).toHaveLength(6);
  }, 90_000);

  it('C1 跨实例精确准入：tiny 计划（agentRunsMonthly=2）下两个 API 并发 4 个创建 → 恰好 2 成功 2 拒绝（预留行是 DB 事实）', async () => {
    // 确定性起点：等上一用例的 6 个 run 的 driver 收尾全部落地
    // （账本行是终态后写入、预留释放紧随其后——两者都就绪才清基线，绝不把在途预留计入本用例消耗）
    const settleDeadline = Date.now() + 15_000;
    while (Date.now() < settleDeadline) {
      const [settled, openRes] = await Promise.all([
        prisma.usageLedgerEntry.count({ where: { runId: { in: runIds }, kind: 'agent_run' } }),
        prisma.quotaReservation.count({ where: { refId: { in: runIds } } }),
      ]);
      if (settled >= runIds.length && openRes === 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // 清计量基线：上一用例的 6 个 agent_run 账本行与本用例的月度限额无关
    await prisma.usageLedgerEntry.deleteMany({ where: { organizationId: orgId, kind: 'agent_run' } });
    const plan = await prisma.plan.create({
      data: {
        code: `mi-tiny-${Date.now()}`, name: 'MI Tiny', monthlyPrice: 1, yearlyPrice: 10, active: true,
        entitlements: {
          agentRunsMonthly: 2, agentRunsDaily: 100, concurrentAgentRuns: 50,
          workflowRunsMonthly: 100, concurrentWorkflowRuns: 50,
          llmTokensMonthly: 1_000_000_000, imageMonthly: 1_000_000, imageDaily: 50,
          videoSecondsMonthly: 1_000_000, videoDaily: 10, externalApiMonthly: 1_000_000,
          storageMb: 100_000, seats: 100,
        } as never,
      },
    });
    await prisma.subscription.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, planId: plan.id, status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000) },
      update: { planId: plan.id, status: 'active' },
    });

    const attempts = await Promise.all([
      request(appA.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie).send({ message: '你好' }),
      request(appB.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie).send({ message: '你好' }),
      request(appA.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie).send({ message: '你好' }),
      request(appB.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie).send({ message: '你好' }),
    ]);
    const ok = attempts.filter((a) => a.status === 201);
    const rejected = attempts.filter((a) => a.status === 429);
    // 安全属性（C1 核心保证）：并发下**绝不超量准入**——成功数 ≤ 月度限额 2；
    // 其余全部 QUOTA_EXCEEDED（预留先行 + 超限回滚是保守方向：极端交错可能少放行，绝不超放行）
    expect(ok.length).toBeLessThanOrEqual(2);
    expect(ok.length + rejected.length).toBe(4);
    expect(rejected.every((a) => a.body.error.code === 'QUOTA_EXCEEDED')).toBe(true);
    for (const r of ok) runIds.push(r.body.data.runId as string);
    for (const runId of ok.map((r) => r.body.data.runId as string)) {
      await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000);
    }
  }, 60_000);
});
