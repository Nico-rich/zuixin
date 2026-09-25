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
import { dayRange, periodOf } from '../src/modules/analytics/analytics.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

const DEFINITION = {
  triggers: [{ type: 'manual' }],
  steps: [{ id: 'done', type: 'output', output: { ok: true } }],
};

async function waitForRun(prisma: PrismaService, runId: string, targets: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    last = run?.status ?? 'missing';
    if (run && targets.includes(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`agentRun ${runId} 未在 ${timeoutMs}ms 内到达 ${targets.join('/')}（当前 ${last}）`);
}

async function waitForWorkflowRun(prisma: PrismaService, runId: string, targets: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
    last = run?.status ?? 'missing';
    if (run && targets.includes(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`workflowRun ${runId} 未在 ${timeoutMs}ms 内到达 ${targets.join('/')}（当前 ${last}）`);
}

/**
 * M8-P4 Analytics / BI e2e（真实 PostgreSQL/Redis/Worker；专用用户 + 专用组织，与全量套件隔离）：
 * 造数（2 个 agent run + 1 个 workflow run）→ 刷新 → overview facts 与事务表逐项一致；
 * 幂等刷新（同一批聚合行，绝不重复统计）；usage 维度与 UsageLedgerEntry 一致；
 * 聚合行 source 追溯；RBAC（非成员 403 / 匿名 401 / 成员 200）。
 */
describe('M8-P4 Analytics / BI (e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookieA = '';
  let cookieB = '';
  let userAId = '';
  let userBId = '';
  let orgA = '';
  let orgB = '';
  const runIds: string[] = [];
  const workflowRunIds: string[] = [];
  let workflowId = '';

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

    // 专用用户 + 专用个人组织（与既有种子数据/其他 spec 完全隔离；slug 遵循 ensurePersonalOrganization 约定）
    const stamp = Date.now();
    const userA = await prisma.user.create({ data: { email: `m8p4-a-${stamp}@example.com`, passwordHash: 'unused-hash' } });
    const userB = await prisma.user.create({ data: { email: `m8p4-b-${stamp}@example.com`, passwordHash: 'unused-hash' } });
    userAId = userA.id;
    userBId = userB.id;
    const createdA = await prisma.organization.create({
      data: { id: `personal-${userA.id}`, name: 'M8P4 A', slug: `personal-${userA.id}`, isPersonal: true, ownerUserId: userA.id, members: { create: { userId: userA.id, role: 'owner' } } },
    });
    const createdB = await prisma.organization.create({
      data: { id: `personal-${userB.id}`, name: 'M8P4 B', slug: `personal-${userB.id}`, isPersonal: true, ownerUserId: userB.id, members: { create: { userId: userB.id, role: 'owner' } } },
    });
    orgA = createdA.id;
    orgB = createdB.id;

    const { JwtService } = await import('@nestjs/jwt');
    const jwt = app.get(JwtService);
    cookieA = `agent_access=${await jwt.signAsync({ sub: userA.id, role: 'user' })}`;
    cookieB = `agent_access=${await jwt.signAsync({ sub: userB.id, role: 'user' })}`;

    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  });

  afterAll(async () => {
    // 聚合行 organizationId 为 SetNull → 必须先删（防孤儿行污染其他 spec）
    await prisma.analyticsAggregate.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } }).catch(() => undefined);
    await prisma.approval.deleteMany({ where: { workflowRunId: { in: workflowRunIds } } }).catch(() => undefined);
    await prisma.workflow.deleteMany({ where: { id: workflowId || 'none' } }).catch(() => undefined); // 级联 versions/runs/steps
    await prisma.generationTask.deleteMany({ where: { userId: { in: [userAId, userBId] } } }).catch(() => undefined);
    await prisma.artifact.deleteMany({ where: { userId: { in: [userAId, userBId] } } }).catch(() => undefined);
    await prisma.usageRecord.deleteMany({ where: { userId: { in: [userAId, userBId] } } }).catch(() => undefined);
    await prisma.agentRunMessage.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
    await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => undefined);
    // Message.user 为 Restrict → 会话须先于 user 删除（会话级联 messages）
    await prisma.conversation.deleteMany({ where: { userId: { in: [userAId, userBId] } } }).catch(() => undefined);
    await prisma.usageLedgerEntry.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } }).catch(() => undefined);
    await prisma.subscription.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  /** 造数（真实 API + Worker）：2 个 agent run + 1 个 workflow run */
  it('P4 造数：2 个 agent run + 1 个 workflow run（真实引擎，终态）', async () => {
    for (const message of ['你好', '统计一下今天的用量']) {
      const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookieA)
        .send({ message }).expect(201);
      runIds.push(res.body.data.runId as string);
    }
    for (const runId of runIds) {
      expect(await waitForRun(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    }

    const created = await request(app.getHttpServer()).post('/api/v1/workflows').set(XRW).set('Cookie', cookieA)
      .send({ name: 'P4 分析工作流', definition: DEFINITION }).expect(201);
    workflowId = created.body.data.id as string;
    await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/publish`).set(XRW).set('Cookie', cookieA).expect(201);
    const run = await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/runs`).set(XRW).set('Cookie', cookieA)
      .send({ payload: { source: 'p4-e2e' } }).expect(201);
    workflowRunIds.push(run.body.data.id as string);
    expect(await waitForWorkflowRun(prisma, workflowRunIds[0], ['completed', 'failed', 'timeout', 'cancelled'], 30_000)).toBe('completed');

    // 工作流归组织（创建时服务端解析个人组织）
    const wf = await prisma.workflow.findUnique({ where: { id: workflowId } });
    expect(wf!.organizationId).toBe(orgA);
  });

  it('P4 overview：facts 与事务表逐项一致（agent/workflow/usage），derived 服务端计算且无 LLM 解读', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/analytics/overview?organizationId=${orgA}&range=day`)
      .set(XRW).set('Cookie', cookieA).expect(200);
    const data = res.body.data;

    const { start, end } = dayRange(periodOf(new Date()));
    // 与 DB 事务表核对（独立查询，非复用服务实现）
    const dbRuns = await prisma.agentRun.findMany({
      where: { userId: userAId, projectId: null, createdAt: { gte: start, lt: end } },
      select: { status: true },
    });
    expect(data.facts.agent.runs).toBe(dbRuns.length);
    expect(data.facts.agent.runs).toBeGreaterThanOrEqual(2);
    expect(data.facts.agent.completed).toBe(dbRuns.filter((r) => r.status === 'completed').length);

    const dbWorkflowRuns = await prisma.workflowRun.count({
      where: { workflow: { organizationId: orgA }, createdAt: { gte: start, lt: end } },
    });
    expect(data.facts.workflow.runs).toBe(dbWorkflowRuns);
    expect(data.facts.workflow.runs).toBeGreaterThanOrEqual(1);
    expect(data.facts.workflow.completed).toBeGreaterThanOrEqual(1);

    expect(data.facts.usage.agent_run).toBeGreaterThanOrEqual(2); // 两个 run 各一条 ledger
    expect(data.meta.source).toEqual(expect.arrayContaining(['usage_ledger', 'agent_run', 'generation_task', 'usage_record', 'workflow_run']));
    expect(data.meta.layering).toMatchObject({ facts: 'deterministic-projection', derived: 'service-computed', interpretation: 'none' });
    expect(data.derived.runSuccessRate).toBeGreaterThan(0);
    expect(data.derived.runSuccessRate).toBeLessThanOrEqual(1);
    expect(data.context.members).toBe(1);
    expect(JSON.stringify(data)).not.toMatch(/insight|narrative|recommendation/i);
  });

  it('P4 幂等：重复刷新只更新同一批聚合行（行 id 不变，绝不重复统计）', async () => {
    const period = periodOf(new Date());
    const before = await prisma.analyticsAggregate.findMany({ where: { organizationId: orgA, period }, select: { id: true, kind: true } });
    expect(before).toHaveLength(5); // 5 维度各一行

    await request(app.getHttpServer()).get(`/api/v1/analytics/overview?organizationId=${orgA}&range=day`)
      .set(XRW).set('Cookie', cookieA).expect(200);
    await request(app.getHttpServer()).get(`/api/v1/analytics/breakdown?organizationId=${orgA}&kind=usage&days=3`)
      .set(XRW).set('Cookie', cookieA).expect(200);

    const after = await prisma.analyticsAggregate.findMany({ where: { organizationId: orgA, period }, select: { id: true } });
    expect(after).toHaveLength(5);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort()); // 同一批行被更新，无新增
  });

  it('P4 kind=usage：与 UsageLedgerEntry 聚合一致（含 llm_tokens/llm_cost 来源标注）', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/analytics/breakdown?organizationId=${orgA}&kind=usage&days=1`)
      .set(XRW).set('Cookie', cookieA).expect(200);
    const data = res.body.data;

    const { start, end } = dayRange(periodOf(new Date()));
    const ledger = await prisma.usageLedgerEntry.findMany({
      where: { organizationId: orgA, createdAt: { gte: start, lt: end } },
      select: { kind: true, quantity: true },
    });
    const expected: Record<string, number> = {};
    for (const entry of ledger) expected[entry.kind] = (expected[entry.kind] ?? 0) + entry.quantity;
    expect(Object.keys(expected).length).toBeGreaterThan(0);

    const today = data.series.filter((row: { period: string }) => row.period === periodOf(new Date()));
    expect(today.length).toBeGreaterThanOrEqual(1);
    expect(today.every((row: { source: string }) => row.source === 'usage_ledger')).toBe(true);
    for (const [kind, total] of Object.entries(expected)) {
      expect(data.facts.usage[kind]).toBeCloseTo(total, 6);
    }
    expect(data.facts.usage.entries).toBe(ledger.length);
    expect(data.meta.layering.facts).toBe('deterministic-projection');
  });

  it('P4 sources：聚合行 source 追溯（kind → 事务表 + 指标键 + 刷新时间）', async () => {
    const period = periodOf(new Date());
    const res = await request(app.getHttpServer()).get(`/api/v1/analytics/sources?organizationId=${orgA}&period=${period}`)
      .set(XRW).set('Cookie', cookieA).expect(200);
    const data = res.body.data;

    expect(data.count).toBe(5);
    expect(data.kindSourceMap).toMatchObject({
      usage: 'usage_ledger', agent: 'agent_run', generation: 'generation_task',
      provider: 'usage_record', workflow: 'workflow_run',
    });
    expect(new Set(data.sources.map((s: { source: string }) => s.source)))
      .toEqual(new Set(['usage_ledger', 'agent_run', 'generation_task', 'usage_record', 'workflow_run']));
    for (const row of data.sources) {
      expect(row.period).toBe(period);
      expect(row.scope).toBe('organization');
      expect(row.metricKeys.length).toBeGreaterThan(0);
      expect(row.refreshedAt).toBeTruthy();
    }
    const agent = data.sources.find((s: { kind: string }) => s.kind === 'agent');
    expect(agent.metricKeys).toEqual(expect.arrayContaining(['runs', 'completed', 'failed', 'cancelled', 'timeout']));
  });

  it('P4 RBAC：他人组织 403 / 匿名 401 / 本组织成员 200', async () => {
    const cross = await request(app.getHttpServer()).get(`/api/v1/analytics/overview?organizationId=${orgB}&range=day`)
      .set(XRW).set('Cookie', cookieA).expect(403);
    expect(cross.body.error.code).toBe('FORBIDDEN');

    await request(app.getHttpServer()).get(`/api/v1/analytics/overview?organizationId=${orgA}&range=day`).set(XRW).expect(401);
    await request(app.getHttpServer()).get(`/api/v1/analytics/breakdown?organizationId=${orgA}`).set(XRW).expect(401);
    await request(app.getHttpServer()).get(`/api/v1/analytics/sources?organizationId=${orgA}`).set(XRW).expect(401);

    // 组织 B 的属主读自己的组织 200；缺省 organizationId = 请求者个人组织
    await request(app.getHttpServer()).get('/api/v1/analytics/overview?range=day').set(XRW).set('Cookie', cookieB).expect(200);
    await request(app.getHttpServer()).get(`/api/v1/analytics/overview?organizationId=${orgB}&range=week`)
      .set(XRW).set('Cookie', cookieB).expect(200);
  });
});
