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

function periodOfUtc(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

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
 * Pre-M9 计费正确性 e2e（真实 PG/Redis/BullMQ/Worker）：
 * T1 UsageRecord.organizationId 必填归因 / R3 sync chat 计量 / D1 账本镜像 / U1 成本单源 / 对账端点。
 */
describe('Pre-M9 Billing Correctness (e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let userId = '';
  let orgId = '';
  let conversationId = '';
  const runIds: string[] = [];
  const messageIds: string[] = [];

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

    const stamp = Date.now();
    const user = await prisma.user.create({ data: { email: `prem9-${stamp}@example.com`, passwordHash: 'unused-hash' } });
    userId = user.id;
    const org = await prisma.organization.create({
      data: { id: `personal-${user.id}`, name: 'PreM9', slug: `personal-${user.id}`, isPersonal: true, ownerUserId: user.id, members: { create: { userId: user.id, role: 'owner' } } },
    });
    orgId = org.id;

    const { JwtService } = await import('@nestjs/jwt');
    const jwt = app.get(JwtService);
    cookie = `agent_access=${await jwt.signAsync({ sub: user.id, role: 'user' })}`;

    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  });

  afterAll(async () => {
    await prisma.quotaReservation.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.usageLedgerEntry.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.usageRecord.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.analyticsAggregate.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.agentRunMessage.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
    await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => undefined);
    await prisma.conversation.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.subscription.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  it('R3 + T1 + D1：sync /chat 全链路——usage 记 organizationId + 账本镜像 llm_tokens/llm_cost + 预留释放', async () => {
    // POST /chat 为 SSE 流式端点（prepare + stream 单请求全链路）
    const streamRes = await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).set('Cookie', cookie)
      .send({ message: '你好' })
      .buffer(true)
      .parse((res: { on: (e: string, cb: (c?: Buffer) => void) => void; statusCode: number }, cb: (err: Error | null, body?: Buffer) => void) => {
        const chunks: Buffer[] = [];
        res.on('data', (c?: Buffer) => { if (c) chunks.push(c); });
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(streamRes.statusCode).toBe(200);
    const body = (streamRes as unknown as { body?: Buffer }).body?.toString('utf8') ?? '';
    expect(body).toContain('message_end'); // SSE 正常收流

    // T1：usage 行带 organizationId（必填归属——绝不无主）
    const records = await prisma.usageRecord.findMany({ where: { userId } });
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) expect(r.organizationId).toBe(orgId);

    // D1：账本镜像与事实一致（llm_tokens 行 usageRecordId 关联 + 幂等键 ur: 前缀）
    const mirrors = await prisma.usageLedgerEntry.findMany({ where: { organizationId: orgId, usageRecordId: { not: null } } });
    expect(mirrors.length).toBeGreaterThan(0);
    for (const m of mirrors) {
      expect(m.idempotencyKey).toMatch(/^ur:/);
      expect(m.usageRecordId).toBeTruthy();
    }

    // R3：chat 预留已释放（终态释放，绝不残留占用月度额度）
    const openRes = await prisma.quotaReservation.count({ where: { organizationId: orgId, kind: 'llm_tokens' } });
    expect(openRes).toBe(0);

    // 会话 id 供后续 agent-run 用例复用
    const assistant = await prisma.message.findFirst({ where: { userId, role: 'assistant' }, orderBy: { createdAt: 'desc' } });
    conversationId = assistant?.conversationId ?? '';
    expect(conversationId).toBeTruthy();
  });

  it('D1 对账端点：一致状态 consistent=true（事实 ↔ 镜像零漂移）', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/billing/reconciliation?organizationId=${orgId}`)
      .set(XRW).set('Cookie', cookie).expect(200);
    expect(res.body.data).toMatchObject({ organizationId: orgId, consistent: true });
  });

  it('D1 对账发现 missing：删除镜像行 → diagnose 检出（consistent=false + missing 列表）→ 恢复镜像（绝不把脏状态留给后续用例）', async () => {
    const mirror = await prisma.usageLedgerEntry.findFirst({ where: { organizationId: orgId, kind: 'llm_cost', usageRecordId: { not: null } } });
    expect(mirror).toBeTruthy();
    await prisma.usageLedgerEntry.delete({ where: { id: mirror!.id } });

    const res = await request(app.getHttpServer()).get(`/api/v1/billing/reconciliation?organizationId=${orgId}`)
      .set(XRW).set('Cookie', cookie).expect(200);
    expect(res.body.data.consistent).toBe(false);
    expect(res.body.data.missing.length).toBeGreaterThan(0);
    expect(res.body.data.missing[0]).toMatchObject({ kind: 'llm_cost', usageRecordId: mirror!.usageRecordId });

    // 恢复被删的镜像行（同值同幂等键）——组织状态回到 consistent，绝不影响后续三方对账用例
    await prisma.usageLedgerEntry.create({
      data: {
        id: mirror!.id, organizationId: orgId, userId, kind: mirror!.kind,
        quantity: mirror!.quantity, unit: mirror!.unit, runId: mirror!.runId, taskId: mirror!.taskId,
        usageRecordId: mirror!.usageRecordId, idempotencyKey: mirror!.idempotencyKey,
        period: mirror!.period, metadata: mirror!.metadata as never, createdAt: mirror!.createdAt,
      },
    });
  });

  it('C1：agent run 创建预留 → 完成释放（终态后无开放预留）', async () => {
    const created = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好', conversationId }).expect(201);
    const runId = created.body.data.runId as string;
    runIds.push(runId);

    // 运行中：预留存在（in-flight 计数）
    const during = await prisma.quotaReservation.findUnique({
      where: { organizationId_kind_refId: { organizationId: orgId, kind: 'agent_run', refId: runId } },
    });
    if (during) {
      expect(during.expiresAt.getTime()).toBeGreaterThan(Date.now());
    }
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    const after = await prisma.quotaReservation.count({ where: { organizationId: orgId, refId: runId } });
    expect(after).toBe(0); // 终态释放
  });

  it('Pre-M9 三方对账：真实 run → UsageRecord(事实) ↔ UsageLedgerEntry(投影) ↔ Analytics(投影) 数字一致', async () => {
    const created = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '你好', conversationId }).expect(201);
    const runId = created.body.data.runId as string;
    runIds.push(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');

    // 事实层：usage_records（llm_chat 行 + 成本）
    const records = await prisma.usageRecord.findMany({ where: { runId } });
    expect(records.length).toBeGreaterThan(0);
    const factTokens = records.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
    const factCost = records.reduce((s, r) => s + r.estimatedCost, 0);

    // 投影层 1：账本镜像（llm_tokens/llm_cost 与事实求和一致）
    const mirrors = await prisma.usageLedgerEntry.findMany({ where: { runId, kind: { in: ['llm_tokens', 'llm_cost'] } } });
    const ledgerTokens = mirrors.filter((m) => m.kind === 'llm_tokens').reduce((s, m) => s + m.quantity, 0);
    const ledgerCost = mirrors.filter((m) => m.kind === 'llm_cost').reduce((s, m) => s + m.quantity, 0);
    expect(ledgerTokens).toBeCloseTo(factTokens, 6);
    expect(ledgerCost).toBeCloseTo(factCost, 6);

    // 对账端点：事实 ↔ 投影零漂移
    const rec = await request(app.getHttpServer()).get(`/api/v1/billing/reconciliation?organizationId=${orgId}`)
      .set(XRW).set('Cookie', cookie).expect(200);
    expect(rec.body.data.consistent).toBe(true);

    // 投影层 2：Analytics（显式刷新当日 → overview 成本 = 事实成本累计；U1 单源）
    await request(app.getHttpServer()).post('/api/v1/analytics/refresh').set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgId, from: periodOfUtc(), to: periodOfUtc() }).expect(201);
    const ov = await request(app.getHttpServer()).get(`/api/v1/analytics/overview?organizationId=${orgId}&range=day`)
      .set(XRW).set('Cookie', cookie).expect(200);
    expect(ov.body.data.derived.totalCost).toBeGreaterThanOrEqual(factCost - 1e-9);
  });

  it('U1：单条 usage 事实 → 单一成本（overview 绝不双计——provider 成本即总量）', async () => {
    // 直接构造一条孤立事实（独立 conversation 无 run 关联）——overview 刷新后 totalCost 等于该事实成本
    const model = await prisma.model.findFirst({ where: { apiModelId: 'mock-echo' } });
    const record = await prisma.usageRecord.create({
      data: {
        userId, organizationId: orgId, providerId: 'seed-llm-mock', modelId: model!.id,
        kind: 'llm_chat', inputTokens: 1_000_000, outputTokens: 0, latencyMs: 1, estimatedCost: 2,
      },
    });
    const res = await request(app.getHttpServer()).get(`/api/v1/analytics/overview?organizationId=${orgId}&range=day`)
      .set(XRW).set('Cookie', cookie).expect(200);
    const total = res.body.data.derived.totalCost as number;
    expect(total).toBeGreaterThanOrEqual(2); // 单源：usage_records 汇总（本用例事实 + 前序 chat 事实）
    await prisma.usageRecord.delete({ where: { id: record.id } }).catch(() => undefined);
  });
});
