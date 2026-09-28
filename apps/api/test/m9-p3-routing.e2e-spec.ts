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
import { MediaGenerationService } from '../src/modules/generations/media-generation.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
/** 首选（routingPolicy.defaults.llm）与回退候选（链上第二顺位） */
const PRIMARY = 'seed-llm-mock';
const SECONDARY = 'seed-llm-mock-router';

interface CandidateRecord {
  providerId: string; modelId: string | null; reasonCode: string; accepted: boolean;
  breakerState?: string; healthScore?: number; latencyMs?: number | null;
}

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

/** 媒体任务终态等待：任务先由队列 worker 认领；若仍 pending（消费者未订阅）则由容器内直接执行（幂等 claim）。 */
async function waitForTaskStatus(app: INestApplication, prisma: PrismaService, taskId: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let kicked = false;
  let status = '';
  while (Date.now() < deadline) {
    status = (await prisma.generationTask.findUnique({ where: { id: taskId }, select: { status: true } }))?.status ?? 'missing';
    if (status === 'completed' || status === 'failed' || status === 'missing') return status;
    if (!kicked && status === 'pending') {
      kicked = true;
      await app.get(MediaGenerationService).executeTask(taskId); // 等价于 worker 消费（原子 claim，重复消费安全）
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return status;
}

/**
 * M9-P3 Provider Routing 生产接线 e2e（真实 PostgreSQL/Redis/BullMQ + 真实 Worker）：
 * 四条调用链（LLM/Image/Embedding；Video 与 Image 同管道且由 video e2e 覆盖执行路径）经同一
 * RoutingService 决策，且决策**全部落库可审计**：
 *   1) 真实 agent run → RoutingDecision（capability=text_generation）+ 归因与决策一致；
 *   2) 审计查询 API（runId + organizationId）可查决策与候选链；
 *   3) 熔断 open 的 provider 被跳过（candidate.reasonCode=circuit_open）→ secondary 承载；
 *   4) 组织策略 deny 生效（candidate.reasonCode=policy_deny，敏感数据不流向被禁 provider）；
 *   5) 全部候选被拒 → PROVIDER_UNAVAILABLE（run failed + 决策行 denied 留痕）；
 *   6) Image 链：真实生图任务 → 决策审计 capability=image_generation + 归因一致；
 *   7) Embedding 链：真实知识索引 → 决策审计 capability=embedding。
 *
 * 隔离：独立 Redis DB 7（熔断/队列/决策绝不污染共享 DB 0/2/3/4 上的其他套件）；
 * 用独立用户 + 独立个人组织（ProviderPolicy 按组织隔离），用例自清理。
 */
describe('M9-P3 Provider Routing 生产接线 (e2e, 真实 Queue + Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie = '';
  let userId = '';
  let orgId = '';
  const runIds: string[] = [];
  const extraDecisionIds: string[] = [];
  const startedAt = new Date(); // 本套件时间窗：媒体/嵌入决策按时间窗取本套件产物（不误伤其他套件）

  const decisionOf = (runId: string) =>
    prisma.routingDecision.findFirst({ where: { runId }, orderBy: { decidedAt: 'desc' } });
  const candidatesOf = (row: { candidates: unknown } | null): CandidateRecord[] =>
    ((row?.candidates ?? []) as CandidateRecord[]);
  const candOf = (row: { candidates: unknown } | null, providerId: string) =>
    candidatesOf(row).find((c) => c.providerId === providerId);
  const successUsage = (runId: string) => prisma.usageRecord.findMany({ where: { runId, status: 'success' } });

  beforeAll(async () => {
    process.env.REDIS_URL = 'redis://localhost:6379/7'; // 独立 DB（须在模块构造前设置）
    process.env.MOCK_DELAY_MS = '0';                    // mock 流式零延迟（决策/审计才是本套件断言对象）
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

    // 独立用户（其个人组织 = 政策作用域）——绝不触碰 seed 用户/组织
    const stamp = Date.now();
    const user = await prisma.user.create({ data: { email: `m9-p3-routing-${stamp}@example.com`, passwordHash: 'unused-hash' } });
    userId = user.id;
    const { JwtService } = await import('@nestjs/jwt');
    cookie = `agent_access=${await app.get(JwtService).signAsync({ sub: user.id, role: 'user' })}`;
    orgId = (await prisma.organization.findFirst({ where: { ownerUserId: userId, isPersonal: true } }))?.id ?? '';
    if (!orgId) {
      // 个人组织在首次用量归因时按需创建（T1 单一事实源）——这里显式预热，保证政策作用域稳定
      const { OrganizationsService } = await import('../src/modules/organizations/organizations.service');
      orgId = (await app.get(OrganizationsService).ensurePersonalOrganization(userId)).id;
    }
  });

  afterAll(async () => {
    // 复位熔断键（DB 7 内自愈，绝不把 open 状态留给下一个套件）
    try {
      const cb = app.get(CircuitBreakerService);
      for (const id of [PRIMARY, SECONDARY]) await cb.recordSuccess(id);
    } catch { /* 无 app 时忽略 */ }
    await prisma.routingDecision.deleteMany({
      where: { OR: [{ runId: { in: runIds } }, { organizationId: orgId }, { id: { in: extraDecisionIds } }] },
    }).catch(() => undefined);
    await prisma.providerPolicy.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.document.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.generationTask.deleteMany({ where: { userId } }).catch(() => undefined);
    for (const runId of runIds) {
      await prisma.agentRunMessage.deleteMany({ where: { runId } }).catch(() => undefined);
    }
    await prisma.usageRecord.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.usageLedgerEntry.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.quotaReservation.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => undefined);
    await prisma.conversation.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { ownerUserId: userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  async function createRun(message: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message }).expect(201);
    const runId = res.body.data.runId as string;
    runIds.push(runId);
    return runId;
  }

  it('LLM 链：真实 run 产生 RoutingDecision（首选 + 候选链）且归因与决策一致', async () => {
    const runId = await createRun('你好');
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed:');

    const row = await decisionOf(runId);
    expect(row).toBeTruthy();
    expect(row).toMatchObject({
      capability: 'text_generation', providerId: PRIMARY, organizationId: orgId, runId, taskId: null,
    });
    // 候选链：选中者 selected，其余可用者进回退链（fallback）
    expect(candOf(row, PRIMARY)).toMatchObject({ accepted: true, reasonCode: 'selected' });
    expect(candOf(row, SECONDARY)).toMatchObject({ accepted: true, reasonCode: 'fallback' });
    // 评分事实落审计（可复现「为什么是它」）：健康分 + 延迟样本（null = 无样本，绝不臆造）
    expect(typeof candOf(row, PRIMARY)!.healthScore).toBe('number');
    expect(candOf(row, PRIMARY)!.latencyMs === null || typeof candOf(row, PRIMARY)!.latencyMs === 'number').toBe(true);
    expect(candOf(row, PRIMARY)!.breakerState).toBe('healthy');

    // 事实一致：回退未发生（首选承载）→ usage 归因 = 决策 provider
    const usage = await successUsage(runId);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.providerId === PRIMARY)).toBe(true);
  }, 60_000);

  it('审计查询 API：runId + organizationId 可查决策与候选链（组织外一律 403）', async () => {
    const runId = runIds[0];
    const res = await request(app.getHttpServer())
      .get(`/api/v1/routing/decisions?runId=${runId}&organizationId=${orgId}`).set(XRW).set('Cookie', cookie).expect(200);
    const rows = res.body.data as Array<{ runId: string; capability: string; providerId: string; candidates: CandidateRecord[] }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId, capability: 'text_generation', providerId: PRIMARY });
    expect(rows[0].candidates.some((c) => c.reasonCode === 'selected')).toBe(true);
    expect(rows[0].candidates.every((c) => typeof c.accepted === 'boolean')).toBe(true);

    // 只给 runId：按请求者所属组织收窄（绝不越权读他人决策）
    const byRun = await request(app.getHttpServer())
      .get(`/api/v1/routing/decisions?runId=${runId}`).set(XRW).set('Cookie', cookie).expect(200);
    expect((byRun.body.data as Array<{ runId: string }>)).toHaveLength(1);
  }, 30_000);

  it('熔断 open → provider 被跳过（circuit_open）+ 决策链换 secondary，run 仍完成', async () => {
    const cb = app.get(CircuitBreakerService);
    for (let i = 0; i < 5; i++) await cb.recordFailure(PRIMARY); // 阈值 5 → open（与 worker 同源视图）
    expect(await cb.state(PRIMARY)).toBe('open');
    expect(await worker.get(CircuitBreakerService).state(PRIMARY)).toBe('open');

    const runId = await createRun('你好');
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed:');

    const row = await decisionOf(runId);
    expect(row!.providerId).toBe(SECONDARY);
    expect(candOf(row, PRIMARY)).toMatchObject({ accepted: false, reasonCode: 'circuit_open', breakerState: 'open' });
    expect(candOf(row, SECONDARY)).toMatchObject({ accepted: true, reasonCode: 'selected' });
    // 归因绝不落到熔断 provider
    const usage = await successUsage(runId);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.providerId === SECONDARY)).toBe(true);

    await cb.recordSuccess(PRIMARY); // 复位：后续场景互不干扰
    expect(await cb.state(PRIMARY)).toBe('healthy');
  }, 60_000);

  it('组织策略 deny → 被禁 provider 硬剔除（policy_deny），敏感数据不流向它', async () => {
    const created = await request(app.getHttpServer()).post('/api/v1/routing/policies').set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgId, providerId: PRIMARY, allow: false }).expect(201);
    const policyId = created.body.data.id as string;

    const runId = await createRun('你好');
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed:');

    const row = await decisionOf(runId);
    expect(candOf(row, PRIMARY)).toMatchObject({ accepted: false, reasonCode: 'policy_deny', policyId });
    expect(row!.providerId).toBe(SECONDARY);
    // 回退链上绝不出现被禁 provider（deny 是硬剔除，不是排序偏好）
    expect(row!.providerId).not.toBe(PRIMARY);
    const usage = await successUsage(runId);
    expect(usage.every((u) => u.providerId === SECONDARY)).toBe(true);

    await prisma.providerPolicy.deleteMany({ where: { organizationId: orgId, providerId: PRIMARY } });
  }, 60_000);

  it('全部候选被策略拒绝 → PROVIDER_UNAVAILABLE（run failed + 决策行 denied 留痕）', async () => {
    const allLlm = await prisma.provider.findMany({ where: { type: 'llm' }, select: { id: true } });
    await prisma.providerPolicy.createMany({
      data: allLlm.map((p) => ({ organizationId: orgId, providerId: p.id, allow: false, priority: 100, enabled: true })),
    });

    const runId = await createRun('你好');
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('failed:PROVIDER_UNAVAILABLE');
    const row = await decisionOf(runId);
    expect(row).toMatchObject({ providerId: null, reasonCode: 'denied', capability: 'text_generation' });
    expect(candidatesOf(row).length).toBeGreaterThan(0);
    expect(candidatesOf(row).every((c) => !c.accepted)).toBe(true);
    expect(candOf(row, PRIMARY)!.reasonCode).toBe('policy_deny');

    await prisma.providerPolicy.deleteMany({ where: { organizationId: orgId } });
  }, 60_000);

  it('Image 链：真实生图任务经同一 RoutingService 决策 + 审计 capability=image_generation', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).set('Cookie', cookie)
      .send({ message: '帮我做一张科技感主图' })
      .buffer(true).parse((r, cb) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => cb(null, s)); })
      .expect(200);
    const taskId = (res.body as string).match(/"taskId":"([0-9a-f-]+)"/)?.[1];
    expect(taskId).toBeTruthy();
    // 任务由本套件用户的 chat 创建（userId/组织归因即本套件隔离域）
    expect(await waitForTaskStatus(app, prisma, taskId!)).toBe('completed');

    const row = await prisma.routingDecision.findFirst({
      where: { capability: 'image_generation', organizationId: orgId, decidedAt: { gte: startedAt } },
      orderBy: { decidedAt: 'desc' },
    });
    expect(row).toBeTruthy();
    extraDecisionIds.push(row!.id);
    expect(row!.providerId).toBe('seed-img-mock'); // 首选 = routingPolicy.defaults.image（排序偏好，非硬编码）
    expect(candOf(row, 'seed-img-mock')).toMatchObject({ accepted: true, reasonCode: 'selected' });
    // 事实一致：生图用量归因 = 决策 provider
    const media = await prisma.usageRecord.findMany({ where: { taskId: taskId!, kind: 'image' } });
    expect(media.length).toBeGreaterThan(0);
    expect(media.every((u) => u.providerId === 'seed-img-mock')).toBe(true);
  }, 60_000);

  it('Embedding 链：知识索引经同一 RoutingService 决策 + 审计 capability=embedding', async () => {
    const content = '路由接线验证文本。'.repeat(200);
    const created = await request(app.getHttpServer()).post('/api/v1/knowledge/documents').set(XRW).set('Cookie', cookie)
      .send({ name: 'M9-P3 路由验证', sourceType: 'text', content }).expect(201);
    expect(created.body.data.status).toBe('ready');

    const row = await prisma.routingDecision.findFirst({
      where: { capability: 'embedding', decidedAt: { gte: startedAt } }, orderBy: { decidedAt: 'desc' },
    });
    expect(row).toBeTruthy();
    extraDecisionIds.push(row!.id); // 嵌入决策无组织归因（检索路径无组织上下文）→ 按 id 清理
    expect(row!.providerId).toBe('seed-emb-mock');
    expect(candidatesOf(row!).some((c) => c.reasonCode === 'selected')).toBe(true);
  }, 60_000);
});
