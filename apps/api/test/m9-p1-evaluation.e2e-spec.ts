import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { EVALUATION_QUEUE } from '../src/core/queue/queue.module';

/**
 * M9-P1 Evaluation / Experimentation e2e（真实 PostgreSQL + Redis + BullMQ Worker + 真实 HTTP + 真实 LLM 抽象）。
 *
 * **必须使用独立 Redis DB（并行 worktree 队列隔离——M8 教训，绝不省略）**：
 *   REDIS_URL=redis://localhost:6379/5 npx vitest run test/m9-p1-evaluation.e2e-spec.ts
 * （文件内在未设置时兜底为 DB 5，避免裸跑污染共享队列。）
 *
 * 端到端事实（绝不 mock 掉 worker/queue 本身）：
 * ① 真实队列 + 真实 Worker + 真实 LLM 抽象（mock 适配器替身）跑完 3 case：
 *    caseRun 事实（output/tokens/cost/toolCalls）与每 case 每评测器一行结果落库、run 终态 completed、聚合可读；
 * ② 创建即锁定（configSnapshot 冻结 modelId/evaluatorIds/datasetVersion）+ 用量走既有唯一计价点（含账本镜像）；
 * ③ RBAC：匿名 401；非成员集合端点 403、资源端点 404（防枚举）；viewer 只读（写 403）；**member 无 evaluation.write**；
 * ④ baseline 对照（同版本 comparable=true、逐 case 对齐；无基线 → null）+ 被引用的评测器不可删（400）；
 * ⑤ **版本锁定**：编辑数据集（bump 到 v2）绝不改变历史 run 的 case 集合与结果行；
 * ⑥ LLM-as-judge 越权面为零：判定只进 EvaluationResult（跨表爆炸半径 = 0）；输出不可解析 → 0 分 + 原文证据；
 * ⑦ 取消：pending → cancelled 后绝不重开（重投 job 认领失败、0 case 执行）；终态取消 → 409；
 * ⑧ 实验状态机 + 流量不变量 + 变体评测对照（读路径派生，无新表）。
 */
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/5';
process.env.MOCK_DELAY_MS = process.env.MOCK_DELAY_MS ?? '0'; // 替身即时输出（确定性、快）

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const STAMP = Date.now();
/** mock 适配器的确定性回复模板（与本文件断言的期望输出同源——替身契约变化必须显式暴露） */
const mockReply = (q: string) => `[mock] 收到你的消息："${q}"。这是本地 mock 模型回复，配置真实 Provider 后即可获得真实回答。`;
/** case A 输入内含可解析的 judge 结论（判官输出 = 回显输入 → 端到端覆盖"判官给通过"的路径） */
const CASE_A = '评测用例 A：请先给出评审结论 {"score":1,"passed":true,"reason":"mock 判官"}，再回答问题';
const CASE_A_OUT = mockReply(CASE_A);
const CASE_B = '评测用例 B：请回答';
const CASE_C = '评测用例 C：请回答';

async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface RunDetail {
  run: { status: string; completedCases: number; totalCases: number; datasetVersion: number; configSnapshot: Record<string, unknown> };
  cases: Array<{
    id: string; caseId: string; status: string; output: { text: string } | null;
    promptTokens: number; completionTokens: number; cost: number; toolCalls: unknown;
    results: Array<{ evaluatorId: string; score: number; passed: boolean; evidence: Record<string, unknown> }>;
    case: { id: string; input: unknown; expected: unknown } | null;
  }>;
  scores: {
    evaluators: Array<{ evaluatorId: string; evaluated: number; passed: number; avgScore: number; passRate: number }>;
    overall: { evaluated: number; passed: number; failed: number; avgScore: number; passRate: number };
    caseRuns: { total: number; completed: number; failed: number; pending: number; skipped: number };
  };
}

describe('M9-P1 Evaluation / Experimentation (e2e, 真实队列+Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;

  let cookieOwner = '';
  let cookieMember = '';
  let cookieViewer = '';
  let cookieOutsider = '';
  let orgA = '';
  let agentVersionId = '';

  let datasetId = '';
  let evExactId = '';
  let evRuleId = '';
  let evJudgeId = '';
  let run1Id = '';
  let run2Id = '';
  let run3Id = '';
  let cancelledRunId = '';
  let experimentId = '';

  const cleanupUserIds: string[] = [];
  const cleanupRunIds: string[] = [];
  const cleanupDatasetIds: string[] = [];
  const cleanupEvaluatorIds: string[] = [];
  const cleanupExperimentIds: string[] = [];
  const modelId = `m9p1-eval-model-${STAMP}`;

  const api = () => request(app.getHttpServer());
  const getRun = async (cookie: string, runId: string) => {
    const res = await api().get(`/api/v1/evaluation/runs/${runId}`).set(XRW).set('Cookie', cookie).expect(200);
    return res.body.data as unknown as RunDetail;
  };
  const awaitRunTerminal = async (runId: string, timeoutMs = 90_000): Promise<RunDetail> => {
    let body: RunDetail | null = null;
    await waitUntil(async () => {
      body = await getRun(cookieOwner, runId);
      return ['completed', 'failed', 'cancelled'].includes(body.run.status);
    }, timeoutMs, `run ${runId} 到达终态（真实 Worker 执行）`);
    return body!;
  };

  beforeAll(async () => {
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

    // 真实 Worker（评测队列消费者；与本 API 共用同一独立 Redis DB 5）
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });

    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);
    const login = await api().post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    expect([200, 201]).toContain(login.status);
    cookieOwner = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');

    const org = await api().post('/api/v1/organizations').set(XRW).set('Cookie', cookieOwner)
      .send({ name: `m9p1-eval-org-${STAMP}` }).expect(201);
    orgA = (org.body.data as { id: string }).id;
    const mkUser = async (tag: string, role: 'member' | 'viewer' | null) => {
      const u = await prisma.user.create({ data: { email: `m9p1-eval-${tag}-${STAMP}@example.com`, passwordHash: 'unused-hash' } });
      cleanupUserIds.push(u.id);
      if (role) await prisma.organizationMember.create({ data: { organizationId: orgA, userId: u.id, role } });
      return `agent_access=${await jwt.signAsync({ sub: u.id, role: 'user' })}`;
    };
    cookieMember = await mkUser('member', 'member');
    cookieViewer = await mkUser('viewer', 'viewer');
    cookieOutsider = await mkUser('outsider', null);

    // 锁定的 Agent 版本（seed 的 builtin Agent；其版本无 modelId → run 显式覆盖为带价 mock 模型）
    const agent = await prisma.agent.findFirstOrThrow({ where: { slug: 'general-assistant' }, include: { activeVersion: true } });
    agentVersionId = agent.activeVersion!.id;
    // 本套件专属带价模型（绝不改 seed 行；价格使成本断言成为精确等式而非 >0 的弱断言）
    await prisma.model.create({
      data: {
        id: modelId, providerId: 'seed-llm-mock', name: 'M9P1 Eval Mock', apiModelId: 'mock-echo',
        type: 'llm', capabilities: {}, enabled: true, priority: 99, inputPrice: 2, outputPrice: 8,
      },
    });

    // 数据集（3 case：命中 / 不命中 / 未定义 expected）
    const ds = await api().post('/api/v1/evaluation/datasets').set(XRW).set('Cookie', cookieOwner)
      .send({
        organizationId: orgA,
        name: `m9p1 ds ${STAMP}`,
        cases: [
          { input: CASE_A, expected: CASE_A_OUT, tags: ['pass'] },
          { input: CASE_B, expected: '完全不符合的期望输出', tags: ['fail'] },
          { input: { message: CASE_C }, expected: null },
        ],
      }).expect(201);
    datasetId = (ds.body.data as { id: string }).id;
    cleanupDatasetIds.push(datasetId);

    const mkEvaluator = async (body: Record<string, unknown>) => {
      const res = await api().post('/api/v1/evaluation/evaluators').set(XRW).set('Cookie', cookieOwner)
        .send({ organizationId: orgA, ...body }).expect(201);
      const id = (res.body.data as { id: string }).id;
      cleanupEvaluatorIds.push(id);
      return id;
    };
    evExactId = await mkEvaluator({ name: `exact ${STAMP}`, type: 'exact_match', config: {} });
    evRuleId = await mkEvaluator({ name: `rule ${STAMP}`, type: 'rule', config: { rules: [{ type: 'contains', value: '评测用例' }] } });
    evJudgeId = await mkEvaluator({ name: `judge ${STAMP}`, type: 'llm_judge', config: { prompt: '请评审以下输出：\n{{output}}' } });

    // run1：真实执行（3 case × 3 evaluator）
    const r1 = await api().post('/api/v1/evaluation/runs').set(XRW).set('Cookie', cookieOwner)
      .send({ organizationId: orgA, datasetId, agentVersionId, evaluatorIds: [evExactId, evRuleId, evJudgeId], modelId })
      .expect(201);
    run1Id = (r1.body.data as { runId: string }).runId;
    cleanupRunIds.push(run1Id);
    await awaitRunTerminal(run1Id);
  }, 180_000);

  afterAll(async () => {
    const queue = new Queue(EVALUATION_QUEUE, { connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null } });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await prisma?.evaluationResult.deleteMany({ where: { caseRun: { runId: { in: cleanupRunIds } } } }).catch(() => undefined);
    await prisma?.evaluationCaseRun.deleteMany({ where: { runId: { in: cleanupRunIds } } }).catch(() => undefined);
    await prisma?.evaluationRun.deleteMany({ where: { id: { in: cleanupRunIds } } }).catch(() => undefined);
    await prisma?.evaluationCase.deleteMany({ where: { datasetId: { in: cleanupDatasetIds } } }).catch(() => undefined);
    await prisma?.evaluationDataset.deleteMany({ where: { id: { in: cleanupDatasetIds } } }).catch(() => undefined);
    await prisma?.evaluator.deleteMany({ where: { id: { in: cleanupEvaluatorIds } } }).catch(() => undefined);
    await prisma?.experimentVariant.deleteMany({ where: { experimentId: { in: cleanupExperimentIds } } }).catch(() => undefined);
    await prisma?.experiment.deleteMany({ where: { id: { in: cleanupExperimentIds } } }).catch(() => undefined);
    if (orgA) {
      // 计费/观测事实（评测经唯一计价点写入）先清，再删组织（外键约束）
      await prisma.usageRecord.deleteMany({ where: { organizationId: orgA } }).catch(() => undefined);
      await prisma.usageLedgerEntry.deleteMany({ where: { organizationId: orgA } }).catch(() => undefined);
      await prisma.metricSample.deleteMany({ where: { organizationId: orgA } }).catch(() => undefined);
      await prisma.organizationMember.deleteMany({ where: { organizationId: orgA } }).catch(() => undefined);
      await prisma.organization.deleteMany({ where: { id: orgA } }).catch(() => undefined);
    }
    await prisma?.model.deleteMany({ where: { id: modelId } }).catch(() => undefined);
    await prisma?.user.deleteMany({ where: { id: { in: cleanupUserIds } } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await prisma?.$disconnect().catch(() => undefined);
  }, 120_000);

  it('① 真实 Worker 跑完 3 case：事实落库、每 case 每评测器一行结果、run completed 且聚合可读', async () => {
    const detail = await awaitRunTerminal(run1Id);
    expect(detail.run.status).toBe('completed');
    expect(detail.run.completedCases).toBe(3);
    expect(detail.run.totalCases).toBe(3);
    expect(detail.run.datasetVersion).toBe(1);
    expect(detail.cases).toHaveLength(3);
    expect(detail.scores.caseRuns).toMatchObject({ total: 3, completed: 3, failed: 0, pending: 0 });

    // case 事实：真实 LLM 抽象产出 output/tokens/cost；评测绝不执行工具 → toolCalls 为 null
    const caseA = detail.cases.find((c) => (c.output?.text ?? '').includes(CASE_A))!;
    expect(caseA.status).toBe('completed');
    expect(caseA.output!.text).toBe(CASE_A_OUT);
    expect(caseA.promptTokens).toBe(4);
    expect(caseA.completionTokens).toBe(Math.ceil(CASE_A_OUT.length / 4));
    expect(caseA.cost).toBe(Math.round(((4 * 2 + Math.ceil(CASE_A_OUT.length / 4) * 8) / 1_000_000) * 1_000_000) / 1_000_000);
    expect(caseA.toolCalls).toBeNull();
    // 锁定的 case 行（v1）可回溯：expected 与创建时逐字一致
    expect(caseA.case!.expected).toBe(CASE_A_OUT);

    // 结果行：3 case × 3 evaluator = 9 行，(caseRunId,evaluatorId) 唯一
    const results = await prisma.evaluationResult.findMany({ where: { caseRun: { runId: run1Id } } });
    expect(results).toHaveLength(9);
    expect(new Set(results.map((r) => `${r.caseRunId}:${r.evaluatorId}`)).size).toBe(9);

    // 分数：exact_match 1/3、rule 3/3、llm_judge 1/3（case A 的判官输出可解析为 score=1）
    const per = (id: string) => detail.scores.evaluators.find((e) => e.evaluatorId === id)!;
    expect(per(evExactId)).toMatchObject({ evaluated: 3, passed: 1, passRate: 0.333333, avgScore: 0.333333 });
    expect(per(evRuleId)).toMatchObject({ evaluated: 3, passed: 3, passRate: 1, avgScore: 1 });
    expect(per(evJudgeId)).toMatchObject({ evaluated: 3, passed: 1, passRate: 0.333333, avgScore: 0.333333 });
    expect(detail.scores.overall).toMatchObject({ evaluated: 9, passed: 5, failed: 4, passRate: 0.555556, avgScore: 0.555556 });
  }, 120_000);

  it('② 创建即锁定：configSnapshot 冻结 modelId/evaluatorIds/datasetVersion；用量走既有唯一计价点', async () => {
    const run = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run1Id } });
    const snap = run.configSnapshot as Record<string, unknown>;
    expect(snap).toMatchObject({
      schema: 1, agentId: expect.any(String), agentSlug: 'general-assistant', agentVersionId,
      datasetId, datasetVersion: 1, modelId, temperature: 0.7, evaluatorIds: [evExactId, evRuleId, evJudgeId],
    });
    expect(snap.overrides).toEqual({ modelId });
    expect(typeof snap.lockedAt).toBe('string');

    // 用量：每 case 一条 UsageRecord（组织归属正确；messageId/runId **不传**——绝不误归因为 AgentRun）
    const usage = await prisma.usageRecord.findMany({ where: { organizationId: orgA, modelId } });
    expect(usage).toHaveLength(3);
    expect(usage.every((u) => u.runId === null && u.messageId === null && u.status === 'success')).toBe(true);
    expect(usage.every((u) => u.inputTokens === 4 && u.outputTokens > 0 && u.estimatedCost > 0)).toBe(true);
    // 成本口径 = computeCost 同源公式（模型目录价 2/8 per 1M tokens）
    for (const u of usage) {
      expect(u.estimatedCost).toBe(Math.round(((4 * 2 + u.outputTokens * 8) / 1_000_000) * 1_000_000) / 1_000_000);
    }
    // 账本严格投影：每条记录 → llm_tokens + llm_cost 两行（共 6 行），绝无空行
    const ledger = await prisma.usageLedgerEntry.findMany({ where: { organizationId: orgA } });
    expect(ledger).toHaveLength(6);
    expect(ledger.every((l) => l.quantity > 0 && l.usageRecordId !== null)).toBe(true);
  });

  it('③ RBAC：匿名 401、非成员 403/404、viewer 只读（写 403）、member 无 evaluation.write（写 403）', async () => {
    // 匿名 → 401（读与写一致）
    for (const attempt of [
      api().get('/api/v1/evaluation/datasets').set(XRW),
      api().get(`/api/v1/evaluation/runs/${run1Id}`).set(XRW),
      api().post('/api/v1/evaluation/runs').set(XRW).send({ datasetId, agentVersionId }),
      api().get('/api/v1/evaluation/experiments').set(XRW),
    ]) {
      expect((await attempt).status).toBe(401);
    }

    // 非成员：集合端点 403（requirePermission）；资源端点 404（防枚举，响应体零字段泄漏）
    expect((await api().get(`/api/v1/evaluation/datasets?organizationId=${orgA}`).set(XRW).set('Cookie', cookieOutsider)).status).toBe(403);
    expect((await api().post('/api/v1/evaluation/runs').set(XRW).set('Cookie', cookieOutsider)
      .send({ organizationId: orgA, datasetId, agentVersionId })).status).toBe(403);
    const hidden = await api().get(`/api/v1/evaluation/runs/${run1Id}`).set(XRW).set('Cookie', cookieOutsider);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(hidden.body)).not.toContain(`m9p1 ds ${STAMP}`);
    expect((await api().get(`/api/v1/evaluation/datasets/${datasetId}`).set(XRW).set('Cookie', cookieOutsider)).status).toBe(404);
    expect((await api().get(`/api/v1/evaluation/evaluators/${evExactId}`).set(XRW).set('Cookie', cookieOutsider)).status).toBe(404);
    expect((await api().get(`/api/v1/evaluation/runs/${run1Id}/comparison`).set(XRW).set('Cookie', cookieOutsider)).status).toBe(404);

    // viewer：读全通（集合 + 资源 + 对照）
    for (const attempt of [
      api().get(`/api/v1/evaluation/datasets?organizationId=${orgA}`).set(XRW).set('Cookie', cookieViewer),
      api().get(`/api/v1/evaluation/datasets/${datasetId}`).set(XRW).set('Cookie', cookieViewer),
      api().get(`/api/v1/evaluation/evaluators?organizationId=${orgA}`).set(XRW).set('Cookie', cookieViewer),
      api().get(`/api/v1/evaluation/runs/${run1Id}`).set(XRW).set('Cookie', cookieViewer),
      api().get(`/api/v1/evaluation/runs/${run1Id}/comparison`).set(XRW).set('Cookie', cookieViewer),
      api().get(`/api/v1/evaluation/datasets/${datasetId}/versions`).set(XRW).set('Cookie', cookieViewer),
    ]) {
      expect((await attempt).status).toBe(200);
    }
    // viewer：写全 403（且零副作用）
    for (const attempt of [
      api().post('/api/v1/evaluation/datasets').set(XRW).set('Cookie', cookieViewer).send({ organizationId: orgA, name: 'viewer 越权建集' }),
      api().put(`/api/v1/evaluation/datasets/${datasetId}/cases`).set(XRW).set('Cookie', cookieViewer).send({ cases: [{ input: 'viewer 越权改 case' }] }),
      api().patch(`/api/v1/evaluation/datasets/${datasetId}`).set(XRW).set('Cookie', cookieViewer).send({ name: 'viewer 越权改名' }),
      api().post('/api/v1/evaluation/runs').set(XRW).set('Cookie', cookieViewer).send({ organizationId: orgA, datasetId, agentVersionId }),
      api().patch(`/api/v1/evaluation/evaluators/${evExactId}`).set(XRW).set('Cookie', cookieViewer).send({ name: 'viewer 越权改名' }),
      api().delete(`/api/v1/evaluation/evaluators/${evExactId}`).set(XRW).set('Cookie', cookieViewer),
      api().post(`/api/v1/evaluation/runs/${run1Id}/cancel`).set(XRW).set('Cookie', cookieViewer).send({}),
      api().post('/api/v1/evaluation/experiments').set(XRW).set('Cookie', cookieViewer).send({ organizationId: orgA, name: 'viewer 越权实验' }),
    ]) {
      const res = await attempt;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    const ds = await prisma.evaluationDataset.findUniqueOrThrow({ where: { id: datasetId } });
    expect(ds.version).toBe(1);
    expect(ds.name).toBe(`m9p1 ds ${STAMP}`);
    expect(await prisma.evaluationCase.count({ where: { datasetId } })).toBe(3);
    expect(await prisma.evaluationRun.count({ where: { organizationId: orgA } })).toBe(1);
    expect((await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run1Id } })).status).toBe('completed');

    // member 有 evaluation.read（矩阵明示）但**没有** evaluation.write（写仅 owner/admin）
    for (const attempt of [
      api().get(`/api/v1/evaluation/datasets?organizationId=${orgA}`).set(XRW).set('Cookie', cookieMember),
      api().get(`/api/v1/evaluation/evaluators?organizationId=${orgA}`).set(XRW).set('Cookie', cookieMember),
      api().get(`/api/v1/evaluation/runs?organizationId=${orgA}`).set(XRW).set('Cookie', cookieMember),
      api().get(`/api/v1/evaluation/runs/${run1Id}`).set(XRW).set('Cookie', cookieMember),
    ]) {
      expect((await attempt).status).toBe(200);
    }
    for (const attempt of [
      api().post('/api/v1/evaluation/datasets').set(XRW).set('Cookie', cookieMember).send({ organizationId: orgA, name: 'member 越权建集' }),
      api().post('/api/v1/evaluation/experiments').set(XRW).set('Cookie', cookieMember).send({ organizationId: orgA, name: 'member 越权实验' }),
      api().post('/api/v1/evaluation/runs').set(XRW).set('Cookie', cookieMember).send({ organizationId: orgA, datasetId, agentVersionId }),
    ]) {
      expect((await attempt).status).toBe(403);
    }
  }, 60_000);

  it('④ baseline 对照：同版本 comparable=true 且逐 case 对齐；无基线 → null；被引用的评测器不可删', async () => {
    const r2 = await api().post('/api/v1/evaluation/runs').set(XRW).set('Cookie', cookieOwner)
      .send({ organizationId: orgA, datasetId, agentVersionId, evaluatorIds: [evExactId, evRuleId, evJudgeId], modelId, baselineRunId: run1Id })
      .expect(201);
    run2Id = (r2.body.data as { runId: string }).runId;
    cleanupRunIds.push(run2Id);
    const d2 = await awaitRunTerminal(run2Id);
    expect(d2.run.status).toBe('completed');

    const cmp = await api().get(`/api/v1/evaluation/runs/${run2Id}/comparison`).set(XRW).set('Cookie', cookieOwner).expect(200);
    const c = cmp.body.data.comparison as {
      comparable: boolean; candidateRunId: string; baselineRunId: string;
      summary: Record<string, number>;
      cases: Array<{ caseId: string; outcome: string; baseline: { passed: boolean } | null; candidate: { passed: boolean } | null }>;
      evaluators: Array<{ evaluatorId: string; delta: { avgScore: number; passRate: number } }>;
    };
    expect(c.comparable).toBe(true);
    expect(c).toMatchObject({ candidateRunId: run2Id, baselineRunId: run1Id });
    // 确定性替身 → 两侧逐 case 结果一致：绝不制造假差异
    expect(c.summary).toMatchObject({ improved: 0, regressed: 0, unchangedPass: 1, unchangedFail: 2, added: 0, removed: 0 });
    expect(c.cases).toHaveLength(3);
    expect(c.evaluators.map((e) => e.evaluatorId).sort()).toEqual([evExactId, evJudgeId, evRuleId].sort());
    expect(c.evaluators.every((e) => e.delta.avgScore === 0 && e.delta.passRate === 0)).toBe(true);

    // 无基线 → comparison=null（读路径绝不伪造对照）
    const none = await api().get(`/api/v1/evaluation/runs/${run1Id}/comparison`).set(XRW).set('Cookie', cookieOwner).expect(200);
    expect(none.body.data.comparison).toBeNull();

    // 历史事实只读：删除已被结果引用的评测器 → 400（绝不级联销毁历史）
    const del = await api().delete(`/api/v1/evaluation/evaluators/${evExactId}`).set(XRW).set('Cookie', cookieOwner);
    expect(del.status).toBe(400);
    expect(del.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.evaluator.count({ where: { id: evExactId } })).toBe(1);
  }, 120_000);

  it('⑤ 版本锁定：编辑数据集 bump 版本后，历史 run 的 case 与结果逐行不变（可复现性）', async () => {
    const beforeResults = await prisma.evaluationResult.findMany({ where: { caseRun: { runId: run1Id } }, orderBy: { id: 'asc' } });
    const beforeCaseIds = (await prisma.evaluationCaseRun.findMany({ where: { runId: run1Id }, orderBy: { id: 'asc' } })).map((c) => c.caseId);

    const replaced = await api().put(`/api/v1/evaluation/datasets/${datasetId}/cases`).set(XRW).set('Cookie', cookieOwner)
      .send({ cases: [{ input: '版本 2 的全新用例' }] }).expect(200);
    expect(replaced.body.data).toMatchObject({ datasetId, version: 2, caseCount: 1 });

    const versions = await api().get(`/api/v1/evaluation/datasets/${datasetId}/versions`).set(XRW).set('Cookie', cookieOwner).expect(200);
    expect(versions.body.data).toMatchObject({ datasetId, currentVersion: 2 });
    expect(versions.body.data.versions).toEqual([{ version: 1, caseCount: 3 }, { version: 2, caseCount: 1 }]);

    // 历史 run：case 行（v1）与结果行**逐行不变**
    const detail = await getRun(cookieOwner, run1Id);
    const afterResults = await prisma.evaluationResult.findMany({ where: { caseRun: { runId: run1Id } }, orderBy: { id: 'asc' } });
    expect(afterResults.map((r) => ({ id: r.id, score: r.score, passed: r.passed })))
      .toEqual(beforeResults.map((r) => ({ id: r.id, score: r.score, passed: r.passed })));
    const afterCaseRuns = await prisma.evaluationCaseRun.findMany({ where: { runId: run1Id }, orderBy: { id: 'asc' } });
    expect(afterCaseRuns.map((c) => c.caseId)).toEqual(beforeCaseIds);
    expect(afterCaseRuns.map((c) => c.status)).toEqual(['completed', 'completed', 'completed']);
    expect(detail.run.datasetVersion).toBe(1);
    expect(detail.cases.map((c) => JSON.stringify(c.case?.input))).toContain(JSON.stringify(CASE_A));
    expect(detail.cases.every((c) => c.case !== null)).toBe(true);

    // 新 run 走 v2（新旧版本互不影响）
    const r3 = await api().post('/api/v1/evaluation/runs').set(XRW).set('Cookie', cookieOwner)
      .send({ organizationId: orgA, datasetId, agentVersionId, evaluatorIds: [evRuleId], modelId, baselineRunId: run1Id })
      .expect(201);
    run3Id = (r3.body.data as { runId: string }).runId;
    cleanupRunIds.push(run3Id);
    expect(r3.body.data).toMatchObject({ totalCases: 1, datasetVersion: 2 });
    const d3 = await awaitRunTerminal(run3Id);
    expect(d3.run.status).toBe('completed');
    // 跨版本对照 → comparable=false（绝不伪造可比性）
    const cmp = await api().get(`/api/v1/evaluation/runs/${run3Id}/comparison`).set(XRW).set('Cookie', cookieOwner).expect(200);
    expect(cmp.body.data.comparison).toMatchObject({ candidateRunId: run3Id, baselineRunId: run1Id, comparable: false });
  }, 120_000);

  it('⑥ LLM-as-judge 越权面为零：判定只进结果行；解析失败写原文 + 不通过', async () => {
    const membersBefore = await prisma.organizationMember.count({ where: { organizationId: orgA } });
    const providersBefore = await prisma.provider.count();
    const agentVersionsBefore = await prisma.agentVersion.count();
    const modelsBefore = await prisma.model.count();
    const quotasBefore = await prisma.quotaReservation.count({ where: { organizationId: orgA } });

    const judgeResults = await prisma.evaluationResult.findMany({
      where: { caseRun: { runId: run1Id }, evaluatorId: evJudgeId },
    });
    expect(judgeResults).toHaveLength(3);
    // 结果行 = 只读事实列（判官说什么都只落在这里，绝无任何"系统判定"字段）
    expect(Object.keys(judgeResults[0] as unknown as Record<string, unknown>).sort())
      .toEqual(['id', 'caseRunId', 'evaluatorId', 'score', 'passed', 'evidence', 'createdAt'].sort());

    const unparsed = judgeResults.filter((r) => (r.evidence as Record<string, unknown>).parseError !== undefined);
    const parsed = judgeResults.filter((r) => (r.evidence as Record<string, unknown>).parseError === undefined);
    // 可解析 → 采用判官分数（带 passThreshold 证据）；不可解析 → 0 分 + 原文（绝不默认通过）
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ score: 1, passed: true });
    expect(parsed[0].evidence).toMatchObject({ passThreshold: 0.5, judgeModelId: null, reason: 'mock 判官' });
    expect(String((parsed[0].evidence as Record<string, unknown>).raw)).toContain('[mock]');
    expect(unparsed).toHaveLength(2);
    for (const r of unparsed) {
      expect(r.passed).toBe(false);
      expect(r.score).toBe(0);
      expect(String((r.evidence as Record<string, unknown>).parseError)).toBeTruthy();
      expect(String((r.evidence as Record<string, unknown>).raw)).toContain('[mock]'); // 原文留档（可审计）
    }

    // 爆炸半径为 0：judge 判了"通过"，但系统侧任何表都没动（评测域无权限/quota/RBAC/provider 写入路径）
    expect(await prisma.organizationMember.count({ where: { organizationId: orgA } })).toBe(membersBefore);
    expect(await prisma.provider.count()).toBe(providersBefore);
    expect(await prisma.agentVersion.count()).toBe(agentVersionsBefore);
    expect(await prisma.model.count()).toBe(modelsBefore);
    expect(await prisma.quotaReservation.count({ where: { organizationId: orgA } })).toBe(quotasBefore);
    expect((await prisma.organizationMember.findFirstOrThrow({ where: { organizationId: orgA, userId: cleanupUserIds[0] } })).role).toBe('member');
  }, 60_000);

  it('⑦ 取消：pending → cancelled 后绝不重开（重投 job 认领失败、0 case 执行）；终态取消 → 409', async () => {
    const queue = worker.get<Queue>(getQueueToken(EVALUATION_QUEUE));
    await queue.pause();
    try {
      const created = await api().post('/api/v1/evaluation/runs').set(XRW).set('Cookie', cookieOwner)
        .send({ organizationId: orgA, datasetId, agentVersionId, evaluatorIds: [evRuleId], modelId }).expect(201);
      cancelledRunId = (created.body.data as { runId: string }).runId;
      cleanupRunIds.push(cancelledRunId);
      expect(created.body.data).toMatchObject({ status: 'pending', totalCases: 1, datasetVersion: 2 });
      // 队列暂停期间 job 未出队：run 保持 pending、0 结果
      expect((await prisma.evaluationCaseRun.findMany({ where: { runId: cancelledRunId } })).map((c) => c.status)).toEqual(['pending']);
      expect(await prisma.evaluationResult.count({ where: { caseRun: { runId: cancelledRunId } } })).toBe(0);

      const cancelled = await api().post(`/api/v1/evaluation/runs/${cancelledRunId}/cancel`).set(XRW).set('Cookie', cookieOwner).send({}).expect(201);
      expect(cancelled.body.data).toEqual({ runId: cancelledRunId, status: 'cancelled' });
      // 终态绝不重开：再次取消 → 409
      const again = await api().post(`/api/v1/evaluation/runs/${cancelledRunId}/cancel`).set(XRW).set('Cookie', cookieOwner).send({});
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('RUN_NOT_CANCELLABLE');
    } finally {
      await queue.resume();
    }

    // 恢复消费：job 被**真实消费**（worker 指标落库 = 消费的可观测证据），但 run 已终态 → 认领失败、0 case 执行
    await waitUntil(async () => (await prisma.metricSample.count({
      where: { name: 'evaluation_run_duration_ms', labels: { path: ['runId'], equals: cancelledRunId } },
    })) > 0, 60_000, '取消的 job 被真实消费（worker 指标落库）');
    const run = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: cancelledRunId } });
    expect(run.status).toBe('cancelled');
    expect(run.completedAt).not.toBeNull();
    expect(await prisma.evaluationResult.count({ where: { caseRun: { runId: cancelledRunId } } })).toBe(0);
    expect((await prisma.evaluationCaseRun.findMany({ where: { runId: cancelledRunId } })).map((c) => c.status)).toEqual(['pending']);
  }, 150_000);

  it('⑧ 实验：状态机（非法迁移 400、终态保护）+ 流量不变量 + 变体评测对照（读路径派生）', async () => {
    const created = await api().post('/api/v1/evaluation/experiments').set(XRW).set('Cookie', cookieOwner)
      .send({ organizationId: orgA, name: `m9p1 exp ${STAMP}`, hypothesis: { metric: 'context_follow' } }).expect(201);
    experimentId = (created.body.data as { id: string }).id;
    cleanupExperimentIds.push(experimentId);
    expect(created.body.data).toMatchObject({ status: 'draft', organizationId: orgA });

    // 非法迁移：draft → completed 直接拒绝（400），且绝不部分改写
    const illegal = await api().post(`/api/v1/evaluation/experiments/${experimentId}/status`).set(XRW).set('Cookie', cookieOwner).send({ status: 'completed' });
    expect(illegal.status).toBe(400);
    expect(illegal.body.error.code).toBe('VALIDATION_ERROR');
    expect((await prisma.experiment.findUniqueOrThrow({ where: { id: experimentId } })).status).toBe('draft');

    // 变体：流量之和 ≤100；首个自动基线；显式新基线清除旧基线
    const v1 = await api().post(`/api/v1/evaluation/experiments/${experimentId}/variants`).set(XRW).set('Cookie', cookieOwner)
      .send({ name: 'baseline', agentVersionId, trafficPercent: 90 }).expect(201);
    const v1List = v1.body.data.variants as Array<{ id: string; isBaseline: boolean; trafficPercent: number }>;
    expect(v1List).toHaveLength(1);
    expect(v1List[0]).toMatchObject({ isBaseline: true, trafficPercent: 90 });
    const overflow = await api().post(`/api/v1/evaluation/experiments/${experimentId}/variants`).set(XRW).set('Cookie', cookieOwner)
      .send({ name: 'overflow', trafficPercent: 20 });
    expect(overflow.status).toBe(400);
    expect(await prisma.experimentVariant.count({ where: { experimentId } })).toBe(1); // 越界变体绝不落库
    await api().post(`/api/v1/evaluation/experiments/${experimentId}/variants`).set(XRW).set('Cookie', cookieOwner)
      .send({ name: 'challenger', agentVersionId, isBaseline: true, trafficPercent: 10 }).expect(201);
    const variants = await prisma.experimentVariant.findMany({ where: { experimentId }, orderBy: { createdAt: 'asc' } });
    expect(variants.map((v) => v.isBaseline)).toEqual([false, true]); // 单一基线不变量
    expect(variants.reduce((s, v) => s + v.trafficPercent, 0)).toBe(100);

    // 变体评测对照：按 agentVersionId 聚合已完成 run（纯读路径派生，无新表）
    const detail = await api().get(`/api/v1/evaluation/experiments/${experimentId}`).set(XRW).set('Cookie', cookieOwner).expect(200);
    const variant = (detail.body.data as {
      variants: Array<{ id: string; evaluation: { runCount: number; runs: unknown[]; scores: { overall: { evaluated: number } } } | null }>;
    }).variants.find((v) => v.id === v1List[0].id)!;
    expect(variant.evaluation).not.toBeNull();
    expect(variant.evaluation!.runCount).toBeGreaterThanOrEqual(2);
    expect(variant.evaluation!.scores.overall.evaluated).toBeGreaterThanOrEqual(9);

    // 合法迁移 draft → running → completed；completed 不可回到 running
    await api().post(`/api/v1/evaluation/experiments/${experimentId}/status`).set(XRW).set('Cookie', cookieOwner).send({ status: 'running' }).expect(201);
    await api().post(`/api/v1/evaluation/experiments/${experimentId}/status`).set(XRW).set('Cookie', cookieOwner).send({ status: 'completed' }).expect(201);
    const terminal = await api().post(`/api/v1/evaluation/experiments/${experimentId}/status`).set(XRW).set('Cookie', cookieOwner).send({ status: 'running' });
    expect(terminal.status).toBe(400);
    expect((await prisma.experiment.findUniqueOrThrow({ where: { id: experimentId } })).status).toBe('completed');
  }, 120_000);
});
