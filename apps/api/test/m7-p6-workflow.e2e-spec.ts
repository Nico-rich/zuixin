import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { WorkflowTriggersService } from '../src/modules/workflows/workflow-triggers.service';
import { WorkflowLeaseService } from '../src/worker/workflow/workflow-lease.service';
import { EventBusService } from '../src/core/events/event-bus.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

async function waitForRunStatus(prisma: PrismaService, runId: string, targets: string[], timeoutMs = 30_000): Promise<string> {
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

/** 等待该 workflowRun 出现 requested 审批（全链路各 run 都会在审批步骤停留） */
async function waitForApproval(prisma: PrismaService, workflowRunId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const approval = await prisma.approval.findFirst({ where: { workflowRunId, status: 'requested' } });
    if (approval) return approval;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`workflowRun ${workflowRunId} 未在 ${timeoutMs}ms 内出现审批`);
}

// M12-P5：event 触发器已从写入面下线（DTO 拒绝）——DEFINITION 不再含 event；
// 存量语义回归见下方 event 触发用例（直接落库构造存量版本）
const DEFINITION = {
  triggers: [
    { type: 'manual' }, { type: 'webhook' },
    { type: 'schedule', cron: '0 9 * * 1' },
  ],
  steps: [
    { id: 'analyze', type: 'tool', tool: { name: 'commerce.analytics.summary', arguments: { timeRange: { days: 30 } } } },
    { id: 'cond', type: 'condition', condition: { field: 'steps.analyze.output.facts.orders', op: 'gt', value: 0, then: 'brief', else: 'notify' } },
    { id: 'brief', type: 'agent', agent: { message: '请确认创意方向：黑金质感' } },
    { id: 'approve', type: 'approval', approval: { reason: '发布前审批', riskLevel: 'high' } },
    { id: 'publish', type: 'external_action', externalAction: { actionType: 'success', payload: { title: '主图发布' } } },
    { id: 'notify', type: 'output', output: { done: true, route: 'notify' } },
  ],
};

/**
 * M7-P6 Workflow e2e（真实 PostgreSQL/Redis/BullMQ/Worker + mock 连接）：
 * 全链路（tool→condition→agent 子 run waiting→审批 waiting→external_action→output）；
 * 幂等/四种触发器/webhook 签名与防重放/取消/retry/版本锁定/timeout/越权。
 */
describe('M7-P6 Workflow Engine (e2e, 真实 Queue + Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let cookieB: string;
  let userId = '';
  let workflowId = '';
  let webhook: { token: string; secret: string } | null = null;
  let connectionId = '';
  const runIds: string[] = [];

  beforeAll(async () => {
    process.env.MOCK_DELAY_MS = '0';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1/hooks', express.raw({ type: '*/*', limit: '1mb' })); // HMAC 需要原始字节
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

    const userB = await prisma.user.create({ data: { email: `userb-p6-${Date.now()}@example.com`, passwordHash: 'unused-hash' } });
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);
    cookieB = `agent_access=${await jwt.signAsync({ sub: userB.id, role: 'user' })}`;

    // mock 连接 + 最小商域种子（analyze 工具步骤数据底座；幂等清理历史残留）
    const start = await request(app.getHttpServer()).post('/api/v1/connections/mock/start').set(XRW).set('Cookie', cookie).send({}).expect(201);
    const cb = await request(app.getHttpServer()).get('/api/v1/connections/mock/callback').set(XRW).set('Cookie', cookie)
      .query({ state: start.body.data.state, code: 'p6-conn' }).expect(200);
    connectionId = cb.body.data.id;
    await prisma.commerceRevenueMetric.deleteMany({ where: { connectionId } });
    await prisma.commerceTrafficMetric.deleteMany({ where: { connectionId } });
    await prisma.commerceConversionMetric.deleteMany({ where: { connectionId } });
    const now = Date.now();
    const day = (offset: number) => new Date(now - offset * 86400_000);
    await prisma.commerceRevenueMetric.create({
      data: { userId, provider: 'mock', connectionId, periodStart: day(29), periodEnd: day(0), revenue: 1000, orders: 20, refunds: 0, netRevenue: 1000 },
    });
    await prisma.commerceTrafficMetric.create({
      data: { userId, provider: 'mock', connectionId, periodStart: day(29), periodEnd: day(0), dimension: 'all', dimensionValue: 'all', impressions: 10000, visits: 1000, uniqueVisitors: 500 },
    });
    await prisma.commerceConversionMetric.create({
      data: { userId, provider: 'mock', connectionId, periodStart: day(29), periodEnd: day(0), dimension: 'all', dimensionValue: 'all', clicks: 500, addToCart: 50, checkouts: 30, orders: 20, revenue: 1000 },
    });

    // 创建 + 发布工作流（捕获 webhook 凭据）
    const created = await request(app.getHttpServer()).post('/api/v1/workflows').set(XRW).set('Cookie', cookie)
      .send({ name: 'e2e 决策工作流', definition: DEFINITION }).expect(201);
    workflowId = created.body.data.id as string;
    const published = await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/publish`).set(XRW).set('Cookie', cookie).expect(201);
    if (published.body.data.triggerInfo?.webhook?.secret) {
      webhook = published.body.data.triggerInfo.webhook;
    }

    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  });

  afterAll(async () => {
    // 审批先删（workflowRunId SetNull 不留孤儿）
    for (const runId of runIds) {
      await prisma.approval.deleteMany({ where: { workflowRunId: runId } }).catch(() => undefined);
    }
    // 子 AgentRun（metadata.workflowRunId 归属）
    for (const runId of runIds) {
      const childRuns = await prisma.agentRun.findMany({
        where: { metadata: { path: ['workflowRunId'], equals: runId } },
        select: { id: true },
      });
      for (const c of childRuns) {
        await prisma.generationTask.deleteMany({ where: { runId: c.id } }).catch(() => undefined);
        await prisma.artifact.deleteMany({ where: { runId: c.id } }).catch(() => undefined);
        await prisma.usageRecord.deleteMany({ where: { runId: c.id } }).catch(() => undefined);
        await prisma.agentRunMessage.deleteMany({ where: { runId: c.id } }).catch(() => undefined);
        await prisma.agentRun.delete({ where: { id: c.id } }).catch(() => undefined);
      }
    }
    await prisma.externalAction.deleteMany({ where: { idempotencyKey: { in: runIds.flatMap((r) => [`wf:${r}:4`]) } } }).catch(() => undefined);
    await prisma.workflow.delete({ where: { id: workflowId } }).catch(() => undefined); // 级联 versions/runs/steps/webhooks/deliveries
    await prisma.commerceRevenueMetric.deleteMany({ where: { userId } });
    await prisma.commerceTrafficMetric.deleteMany({ where: { userId } });
    await prisma.commerceConversionMetric.deleteMany({ where: { userId } });
    await prisma.credential.deleteMany({ where: { connectionId } });
    await prisma.connection.deleteMany({ where: { id: connectionId } });
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  async function createRun(payload: Record<string, unknown> = {}, idempotencyKey?: string) {
    const res = await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/runs`).set(XRW).set('Cookie', cookie)
      .send({ payload, ...(idempotencyKey ? { idempotencyKey } : {}) }).expect(201);
    const runId = res.body.data.id as string;
    runIds.push(runId);
    return runId;
  }

  async function approveAndWait(runId: string): Promise<string> {
    const approval = await waitForApproval(prisma, runId);
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/approve`).set(XRW).set('Cookie', cookie).expect(201);
    return waitForRunStatus(prisma, runId, ['completed', 'failed', 'timeout'], 30_000);
  }

  it('P6 全链路 manual：tool→condition→agent 子 run(waiting 唤醒)→审批(waiting 唤醒)→external_action→output', async () => {
    const runId = await createRun({});
    const status = await approveAndWait(runId);
    expect(status).toBe('completed');

    const run = await prisma.workflowRun.findUnique({ where: { id: runId }, include: { steps: { orderBy: { stepIndex: 'asc' } } } });
    expect(run).toBeTruthy();
    expect(run!.output).toMatchObject({ done: true, route: 'notify' });
    expect(run!.versionId).toBeTruthy();
    const byId = new Map(run!.steps.map((s) => [s.stepId, s]));
    // analyze：只读工具步骤（facts 来自商域种子）
    expect(byId.get('analyze')!.status).toBe('completed');
    expect((byId.get('analyze')!.output as { facts: { orders: number } }).facts.orders).toBe(20);
    // cond：命中 then → brief
    expect(byId.get('cond')!.status).toBe('completed');
    expect(byId.get('cond')!.output).toMatchObject({ jumpTo: 'brief', hit: true });
    // brief：子 AgentRun 完成（waiting → 唤醒 resume → 终态）
    expect(byId.get('brief')!.status).toBe('completed');
    const childRunId = byId.get('brief')!.agentRunId!;
    expect((await prisma.agentRun.findUnique({ where: { id: childRunId } }))?.status).toBe('completed');
    // approve：审批步骤（approvalId 绑定）
    expect(byId.get('approve')!.status).toBe('completed');
    expect(byId.get('approve')!.approvalId).toBeTruthy();
    expect((await prisma.approval.findUnique({ where: { id: byId.get('approve')!.approvalId! } }))?.status).toBe('approved');
    // publish：外部动作（审批复核 + 幂等键 + 审计行）
    expect(byId.get('publish')!.status).toBe('completed');
    const action = await prisma.externalAction.findUnique({
      where: { userId_provider_idempotencyKey: { userId, provider: 'mock', idempotencyKey: `wf:${runId}:4` } },
    });
    expect(action?.status).toBe('completed');
    expect(action?.approvalId).toBe(byId.get('approve')!.approvalId);
    // notify：输出步骤
    expect(byId.get('notify')!.status).toBe('completed');
    // waiting 期间 lease 释放过（快照不可考，但终态字段干净）
    expect(run!.waitingOnApprovalId).toBeNull();
    expect(run!.waitingOnAgentRunId).toBeNull();

    // Timeline 投影
    const timeline = await request(app.getHttpServer()).get(`/api/v1/workflows/runs/${runId}/timeline`).set(XRW).set('Cookie', cookie).expect(200);
    expect((timeline.body.data.items as Array<{ type: string }>).some((i) => i.type === 'workflow.completed')).toBe(true);
    expect((timeline.body.data.items as Array<{ type: string }>).some((i) => i.type === 'step.completed')).toBe(true);
  });

  it('P6 幂等：同一 idempotencyKey 重复创建 → 返回同一 run（DB 仅一行）', async () => {
    const key = `idem-${Date.now()}`;
    const first = await createRun({}, key);
    const res2 = await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/runs`).set(XRW).set('Cookie', cookie)
      .send({ payload: {}, idempotencyKey: key }).expect(201);
    expect(res2.body.data.id).toBe(first);
    await approveAndWait(first);
    expect(await prisma.workflowRun.count({ where: { workflowId, idempotencyKey: key } })).toBe(1);
  });

  it('P6 审批拒绝：run failed(APPROVAL_REJECTED)，绝不继续 external_action', async () => {
    const runId = await createRun({});
    const approval = await waitForApproval(prisma, runId);
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/reject`).set(XRW).set('Cookie', cookie).expect(201);
    const status = await waitForRunStatus(prisma, runId, ['completed', 'failed', 'timeout'], 30_000);
    expect(status).toBe('failed');
    const run = await prisma.workflowRun.findUnique({ where: { id: runId }, include: { steps: { orderBy: { stepIndex: 'asc' } } } });
    expect(run?.errorCode).toBe('APPROVAL_REJECTED');
    // 拒绝后 publish 步骤绝不执行：无步骤行（行仅在执行时创建）+ 无外部动作
    expect(run!.steps.some((s) => s.stepId === 'publish')).toBe(false);
    expect(await prisma.externalAction.count({ where: { idempotencyKey: `wf:${runId}:4` } })).toBe(0);
  });

  it('P6 cancel：waiting（审批中）→ cancelled + 审批附带 cancelled，绝不复活', async () => {
    const runId = await createRun({});
    const approval = await waitForApproval(prisma, runId);
    await request(app.getHttpServer()).post(`/api/v1/workflows/runs/${runId}/cancel`).set(XRW).set('Cookie', cookie).expect(201);
    expect((await prisma.workflowRun.findUnique({ where: { id: runId } }))?.status).toBe('cancelled');
    expect((await prisma.approval.findUnique({ where: { id: approval.id } }))?.status).toBe('cancelled');
    // 重复 cancel → 409；recoverStale 绝不复活
    await request(app.getHttpServer()).post(`/api/v1/workflows/runs/${runId}/cancel`).set(XRW).set('Cookie', cookie).expect(409);
    const lease = worker.get(WorkflowLeaseService);
    await lease.recoverStale();
    expect((await prisma.workflowRun.findUnique({ where: { id: runId } }))?.status).toBe('cancelled');
  });

  it('P6 webhook 触发：HMAC 签名 → run；重放 409 / 坏签名 401 / 过期 timestamp 401 / 未知 token 401', async () => {
    expect(webhook).toBeTruthy();
    const payload = JSON.stringify({ orderId: 'hook-1', amount: 99 });
    // Pre-M9：签名串 = timestamp + eventId + rawBody（顺序固定，见 WebhookHooksController/TriggersService 文档）
    const sign = (timestamp: string, eventId: string, body: string = payload) =>
      createHmac('sha256', webhook!.secret).update(`${timestamp}${eventId}`).update(body).digest('hex');
    const headers = (eventId: string, signature: string, timestamp: string) => ({
      'X-Hook-Signature': signature, 'X-Hook-Timestamp': timestamp, 'X-Hook-Event-Id': eventId,
    });
    const post = (eventId: string, signature: string, timestamp: string, token: string = webhook!.token) =>
      request(app.getHttpServer())
        .post(`/api/v1/hooks/workflows/${token}`)
        .set('Content-Type', 'application/json')
        .set(headers(eventId, signature, timestamp))
        .send(payload);

    const ts1 = String(Date.now());
    const ok = await post('evt-1', sign(ts1, 'evt-1'), ts1).expect(201);
    const runId = ok.body.data.runId as string;
    runIds.push(runId);
    expect(await approveAndWait(runId)).toBe('completed');
    const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
    expect(run?.triggerType).toBe('webhook');
    expect(run?.input).toMatchObject({ orderId: 'hook-1' });

    // 重放同一 eventId（签名有效）→ 409 WEBHOOK_REPLAY
    const ts2 = String(Date.now());
    const replay = await post('evt-1', sign(ts2, 'evt-1'), ts2).expect(409);
    expect(replay.body.error.code).toBe('WEBHOOK_REPLAY');
    // 坏签名 → 401（统一文案，不区分原因）
    const ts3 = String(Date.now());
    const bad = await post('evt-2', 'deadbeef', ts3).expect(401);
    expect(bad.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    // Pre-M9 回归：signature 覆盖 timestamp/eventId —— 同一签名换新 eventId（旧格式下可无限重放）→ 401
    const ts4 = String(Date.now());
    await post('evt-replay-2', sign(ts4, 'evt-1'), ts4).expect(401);
    // Pre-M9 回归：signature 覆盖 timestamp —— 旧签名换个时间戳（旧格式可"重签"绕过时间窗）→ 401
    // 注意：两个时间戳必须**不同**（同毫秒会让用例变成空断言）； tsB 仍在容忍窗内，故只有签名不匹配能拦下它
    const tsA = String(Date.now());
    const tsB = String(Date.now() + 5_000);
    await post('evt-5', sign(tsA, 'evt-5'), tsB).expect(401);
    // 超窗 timestamp（10 分钟前，签名有效）→ 401 WEBHOOK_TIMESTAMP_STALE
    const stale = String(Date.now() - 10 * 60_000);
    const staleRes = await post('evt-3', sign(stale, 'evt-3'), stale).expect(401);
    expect(staleRes.body.error.code).toBe('WEBHOOK_TIMESTAMP_STALE');
    // 未知 token → 401（与坏签名同文案，不可枚举）
    const ts6 = String(Date.now());
    const unknown = await post('evt-4', sign(ts6, 'evt-4'), ts6, 'unknown-token-1234').expect(401);
    expect(unknown.body.error.message).toBe('webhook 鉴权失败');
  });

  it('P6 schedule 触发（直调 tick 模拟 cron）：时间桶幂等——同分钟重复 tick 只产生一个 run', async () => {
    const triggers = worker.get(WorkflowTriggersService);
    await triggers.tickScheduled(workflowId);
    const run = await prisma.workflowRun.findFirst({ where: { workflowId, triggerType: 'schedule' }, orderBy: { createdAt: 'desc' } });
    expect(run).toBeTruthy();
    runIds.push(run!.id);
    await triggers.tickScheduled(workflowId); // 同时间桶 → 幂等
    expect(await prisma.workflowRun.count({ where: { workflowId, triggerType: 'schedule' } })).toBe(1);
    expect(await approveAndWait(run!.id)).toBe('completed');
  });

  it('P6 event 触发（存量语义回归）：EventBus 事件 → run（同 event id 幂等）', async () => {
    // M12-P5：event 触发器类型已从写入面下线（无生产发布端）——存量已发布工作流仍可运行。
    // 本用例按"存量语义"构造：直接落一份含 event 触发器的 published 版本（绕过写 DTO），
    // 再经服务层 registerEvent 订阅——把"存量仍可运行"变成可回归证据（绝不走已下线的写入面）。
    const latest = await prisma.workflowVersion.findFirst({ where: { workflowId, status: 'published' }, orderBy: { version: 'desc' } });
    await prisma.workflowVersion.create({
      data: {
        workflowId,
        version: (latest?.version ?? 0) + 1,
        status: 'published',
        definition: { ...DEFINITION, triggers: [...DEFINITION.triggers, { type: 'event', event: 'wf-e2e-events' }] } as never,
      },
    });
    const triggers = worker.get(WorkflowTriggersService);
    await triggers.registerEvent(workflowId, 'wf-e2e-events');
    const bus = app.get(EventBusService);
    await bus.publish('wf-e2e-events', { id: 'evt-100', payload: { x: 1 } });
    // 等待 event run 出现
    let eventRun: { id: string } | null = null;
    for (let i = 0; i < 100 && !eventRun; i++) {
      eventRun = await prisma.workflowRun.findFirst({ where: { workflowId, triggerType: 'event' } });
      if (!eventRun) await new Promise((r) => setTimeout(r, 100));
    }
    expect(eventRun).toBeTruthy();
    runIds.push(eventRun!.id);
    await bus.publish('wf-e2e-events', { id: 'evt-100', payload: { x: 1 } }); // 同 id → 幂等
    await new Promise((r) => setTimeout(r, 500));
    expect(await prisma.workflowRun.count({ where: { workflowId, triggerType: 'event' } })).toBe(1);
    expect(await approveAndWait(eventRun!.id)).toBe('completed');
  });

  it('P6 retry：失败 run → 新 run（attempt+1），旧 run 保持终态', async () => {
    const failed = await prisma.workflowRun.findFirst({ where: { workflowId, status: 'failed' } });
    expect(failed).toBeTruthy();
    const res = await request(app.getHttpServer()).post(`/api/v1/workflows/runs/${failed!.id}/retry`).set(XRW).set('Cookie', cookie).expect(201);
    const retryId = res.body.data.id as string;
    runIds.push(retryId);
    const retry = await prisma.workflowRun.findUnique({ where: { id: retryId } });
    expect(retry?.attempt).toBe(2);
    expect((await prisma.workflowRun.findUnique({ where: { id: failed!.id } }))?.status).toBe('failed'); // 旧 run 永不重开
    expect(await approveAndWait(retryId)).toBe('completed');
  });

  it('P6 版本不可变：编辑产生新版本（draft），历史 run 锁定旧版本', async () => {
    const res = await request(app.getHttpServer()).patch(`/api/v1/workflows/${workflowId}`).set(XRW).set('Cookie', cookie)
      .send({ definition: { ...DEFINITION, steps: [...DEFINITION.steps, { id: 'extra', type: 'output', output: { extra: true } }] } })
      .expect(200);
    const versions = res.body.data.versions as Array<{ version: number; status: string }>;
    expect(versions[0]).toMatchObject({ version: 2, status: 'draft' });
    const run = await prisma.workflowRun.findFirst({ where: { workflowId }, orderBy: { createdAt: 'desc' }, include: { version: true } });
    expect(run?.version.version).toBe(1); // 全部历史 run 锁定 v1
  });

  it('P6 timeout：waiting 超 deadline → recoverStale 置 timeout（绝不复活）', async () => {
    const wf = await prisma.workflow.findUnique({ where: { id: workflowId } });
    const version = await prisma.workflowVersion.findFirst({ where: { workflowId, status: 'published' } });
    const fabricated = await prisma.workflowRun.create({
      data: {
        workflowId, versionId: version!.id, userId, triggerType: 'manual',
        idempotencyKey: `fab-${Date.now()}`, status: 'waiting',
        startedAt: new Date(Date.now() - 2 * 60 * 60_000), input: {} as never,
      },
    });
    runIds.push(fabricated.id);
    const lease = worker.get(WorkflowLeaseService);
    const res = await lease.recoverStale();
    expect(res.timedOut).toBeGreaterThanOrEqual(1);
    expect((await prisma.workflowRun.findUnique({ where: { id: fabricated.id } }))?.status).toBe('timeout');
    void wf;
  });

  it('P6 越权矩阵：他人 workflow/run/触发 → 404；匿名 401', async () => {
    await request(app.getHttpServer()).get(`/api/v1/workflows/${workflowId}`).set(XRW).expect(401);
    await request(app.getHttpServer()).get(`/api/v1/workflows/${workflowId}`).set(XRW).set('Cookie', cookieB).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/publish`).set(XRW).set('Cookie', cookieB).expect(404);
    const run = await prisma.workflowRun.findFirst({ where: { workflowId } });
    await request(app.getHttpServer()).get(`/api/v1/workflows/runs/${run!.id}`).set(XRW).set('Cookie', cookieB).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/workflows/runs/${run!.id}/cancel`).set(XRW).set('Cookie', cookieB).expect(404);
  });
});
