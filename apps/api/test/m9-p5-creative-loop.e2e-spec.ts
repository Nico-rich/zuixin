import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { stepExternalActionKey } from '../src/modules/workflows/workflow-executor.service';
import { hashPayload } from '../src/modules/approvals/approval-binding';
import { validateDefinition } from '../src/modules/workflows/workflow-types';
import { LOOP_STEP_IDS, buildLoopDefinition } from '../src/modules/creative-loop/loop-template';
import { HYPOTHESIS_KIND, INSIGHT_KIND } from '../src/modules/creative-loop/creative-loop-store';
import { factsHashOf } from '../src/modules/creative-loop/insight-rules';

/**
 * M9-P5 Creative Performance Loop e2e（真实 PostgreSQL/Redis/BullMQ + Worker 进程内实例）。
 *
 * 运行方式（**独立 Redis DB，与 m7-p6/m9-p4 的 db 0/8 隔离**）：
 *   cd apps/api && REDIS_URL=redis://localhost:6379/9 npx vitest run test/m9-p5-creative-loop.e2e-spec.ts
 *
 * 覆盖（闭环全程，**只复用既有系统，绝不新建第二套**）：
 *   ① 洞察：事实/派生层服务端计算（Feedback + CreativePerformance + M9-P1 摘要）+ 分层标注；
 *      LLM 解读独立写入 → facts/derived/factsHash **逐字节不变**（DB 行复核）。
 *   ② 假设状态机：draft 不可启动 loop；draft→ready 后可启动；固化定义 = 模板产物且发布为 v1（版本锁定）。
 *   ③ 人工审批门：run 停在 approval（**写操作尚未执行**）；审批绑定摘要 = 将被执行的动作；生成步骤复用 M5 生成链。
 *   ④ approve → 外部动作（M7-P3 全链：审批 + 幂等键）→ wait 观察窗 → run completed；补偿步骤正常流程不执行。
 *   ⑤ 判据收敛：事实未回流 → 绝不臆断（awaiting-facts）；回流后读路径按判据自动 validated（条件更新）。
 *   ⑥ 拒绝审批 → 写操作**绝不执行** + 假设按 run 终态系统驳回。
 *   ⑦ 条件更新：并发状态推进恰好一个成功；并发启动绝不产生第二个 run；取消 run 不自动终态化 + 人工判定。
 *   ⑧ 租户隔离：非成员一律 404（防枚举），绝不因知道 id 而放行。
 *
 * 说明：本 Phase 无 creative-loop 专表（schema 冻结），假设/洞察以 `Artifact`（type='other'）文档承载——
 * 见 src/modules/creative-loop/creative-loop-store.ts 文件头"已知缺口"。本 spec 的清理按 id 精确删除。
 */

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

async function waitFor<T>(
  label: string,
  fn: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 25_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${label} 未在 ${timeoutMs}ms 内达成（最后值 ${JSON.stringify(last)}）`);
}

describe('M9-P5 Creative Performance Loop (e2e, 真实 Queue + Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let userId = '';
  let projectId = '';

  const hypothesisIds: string[] = [];
  const insightIds: string[] = [];
  const workflowIds: string[] = [];
  const runIds: string[] = [];
  const childRunIds: string[] = [];
  const extraUserIds: string[] = [];

  let outsiderCookie = '';
  let perfCurrentId = '';
  let insightId = '';
  let insightSnapshot: Record<string, unknown> = {};

  /** loop 主链路（①~⑤）共享的假设 */
  let hypothesisId = '';
  let loopRunId = '';
  let loopWorkflowId = '';
  const statement = '换用高对比主图可提升点击率与 ROAS';
  const target = '一线城市 25-34 女性';

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

    worker = await (await import('@nestjs/core')).NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });

    // 闭环数据面容器：专属项目（隔离其他 e2e 留在 admin 名下的绩效/评分事实）
    const project = await request(app.getHttpServer()).post('/api/v1/projects').set(XRW).set('Cookie', cookie)
      .send({ name: `e2e M9-P5 闭环 ${randomUUID().slice(0, 8)}` }).expect(201);
    projectId = project.body.data.id as string;

    // 回流事实：当期（窗口内）+ 前一期（[now-2d, now-d)）；评分：1 条好评 + 1 条差评
    const dayMs = 86400_000;
    const now = Date.now();
    const current = await prisma.creativePerformance.create({
      data: {
        userId, projectId, platform: 'mock',
        periodStart: new Date(now - 30 * dayMs), periodEnd: new Date(now),
        impressions: 1000, clicks: 50, spend: 100, conversions: 5, revenue: 300, orders: 5,
        capturedAt: new Date(now - 1_000),
      },
    });
    perfCurrentId = current.id;
    await prisma.creativePerformance.create({
      data: {
        userId, projectId, platform: 'mock',
        periodStart: new Date(now - 60 * dayMs), periodEnd: new Date(now - 30 * dayMs),
        impressions: 1000, clicks: 40, spend: 100, conversions: 4, revenue: 150, orders: 4,
        capturedAt: new Date(now - 40 * dayMs),
      },
    });
    await prisma.feedback.create({
      data: { userId, projectId, subjectType: 'artifact', subjectId: `e2e-m9p5-${randomUUID()}`, rating: 5 },
    });
    await prisma.feedback.create({
      data: { userId, projectId, subjectType: 'creativeBrief', subjectId: `e2e-m9p5-${randomUUID()}`, rating: 2 },
    });

    // 非成员用户（租户隔离断言；密码哈希复制自 admin → 同一口令）
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
    const outsider = await prisma.user.create({
      data: { email: `e2e-m9p5-outsider-${randomUUID()}@local.test`, passwordHash: admin.passwordHash, displayName: 'e2e 非成员' },
    });
    extraUserIds.push(outsider.id);
    const outsiderLogin = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: outsider.email, password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' }).expect(201);
    outsiderCookie = (outsiderLogin.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  }, 60_000);

  afterAll(async () => {
    // 子 AgentRun 事实链（生成任务 → 附件 → 制品 → 消息 → run；FK 顺序敏感，全部尽力而为）
    if (childRunIds.length > 0) {
      const tasks = await prisma.generationTask.findMany({ where: { runId: { in: childRunIds } }, select: { id: true } }).catch(() => []);
      const taskIds = tasks.map((t) => t.id);
      if (taskIds.length > 0) await prisma.attachment.deleteMany({ where: { taskId: { in: taskIds } } }).catch(() => undefined);
      await prisma.generationTask.deleteMany({ where: { runId: { in: childRunIds } } }).catch(() => undefined);
      await prisma.artifact.deleteMany({ where: { runId: { in: childRunIds } } }).catch(() => undefined);
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: childRunIds } } }).catch(() => undefined);
      await prisma.agentRun.deleteMany({ where: { id: { in: childRunIds } } }).catch(() => undefined);
    }
    // 审批先删（workflowRunId SetNull 不留孤儿）
    for (const runId of runIds) {
      await prisma.approval.deleteMany({ where: { workflowRunId: runId } }).catch(() => undefined);
    }
    // 外部动作按 run 幂等键清理（发布 = 下标 3，回滚 = 下标 4）
    await prisma.externalAction.deleteMany({
      where: { userId, idempotencyKey: { in: runIds.flatMap((r) => [3, 4].map((i) => stepExternalActionKey(r, i))) } },
    }).catch(() => undefined);
    for (const id of workflowIds) {
      await prisma.workflow.delete({ where: { id } }).catch(() => undefined); // 级联 versions/runs/steps
    }
    for (const id of insightIds) {
      await prisma.artifact.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of hypothesisIds) {
      await prisma.artifact.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.creativePerformance.deleteMany({ where: { userId, projectId } }).catch(() => undefined);
    await prisma.feedback.deleteMany({ where: { userId, projectId } }).catch(() => undefined);
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    for (const id of extraUserIds) {
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    await worker?.close().catch(() => undefined);
    await app.close();
  }, 60_000);

  const api = () => request(app.getHttpServer());

  async function createHypothesis(over: Record<string, unknown> = {}): Promise<string> {
    const res = await api().post('/api/v1/creative-loop/hypotheses').set(XRW).set('Cookie', cookie)
      .send({ statement, platform: 'mock', projectId, ...over }).expect(201);
    const id = res.body.data.id as string;
    hypothesisIds.push(id);
    return id;
  }

  it('① 洞察：事实/派生层服务端计算 + 分层标注；解读写入后 facts/derived/factsHash 逐字节不变', async () => {
    const res = await api().post('/api/v1/creative-loop/insights').set(XRW).set('Cookie', cookie)
      .send({ projectId, days: 30, includeEvaluation: false }).expect(201);
    insightId = res.body.data.id as string;
    insightIds.push(insightId);
    const insight = res.body.data as Record<string, never>;
    expect(insight.kind).toBe(INSIGHT_KIND);

    const facts = insight.facts as unknown as Record<string, never>;
    expect(facts.performance).toMatchObject({
      current: { impressions: 1000, clicks: 50, spend: 100, conversions: 5, revenue: 300, orders: 5 },
      previous: { impressions: 1000, clicks: 40, spend: 100, conversions: 4, revenue: 150, orders: 4 },
      sources: { current: 1, previous: 1 },
      rule: 'server-sum',
    });
    expect(facts.ratings).toMatchObject({ count: 2, avgRating: 3.5, positiveRate: 0.5, negativeRate: 0.5, rule: 'server-sum' });

    const derived = insight.derived as unknown as Record<string, never>;
    expect(derived.metrics).toEqual({ ctr: 0.05, cvr: 0.1, roas: 3, cpc: 2 });
    expect(derived.baseline).toEqual({ ctr: 0.04, cvr: 0.1, roas: 1.5, cpc: 2.5 });
    const comparison = Object.fromEntries(
      (derived.comparison as unknown as Array<Record<string, unknown>>).map((c) => [c.metric, c]),
    );
    expect(comparison.ctr).toMatchObject({ base: 0.04, compare: 0.05, changePct: 25, direction: 'up', beyondThreshold: true, rule: 'server-comparison' });
    expect(comparison.cvr).toMatchObject({ changePct: 0, direction: 'flat' });
    expect(comparison.roas).toMatchObject({ changePct: 100, direction: 'up' });
    expect(comparison.cpc).toMatchObject({ changePct: -20, direction: 'down' });

    expect(insight.layering).toEqual({ facts: 'service-computed', derived: 'service-computed', interpretation: 'llm-interpretation' });
    expect(insight.interpretation).toBeNull();
    expect(insight.factsHash).toBe(factsHashOf(insight.facts, insight.derived)); // 指纹 = 事实层，解读不参与

    // 评测事实（默认聚合）：只读 M9-P1 摘要（结构断言——组织内 run 集合随回归状态变化）
    const withEval = await api().post('/api/v1/creative-loop/insights').set(XRW).set('Cookie', cookie)
      .send({ projectId, days: 30 }).expect(201);
    insightIds.push(withEval.body.data.id as string);
    const evalFacts = (withEval.body.data.facts as Record<string, never>).evaluation as unknown as {
      runs: Array<Record<string, unknown>>; rule: string;
    };
    expect(evalFacts.rule).toBe('evaluation-run-summary');
    expect(Array.isArray(evalFacts.runs)).toBe(true);
    for (const row of evalFacts.runs) {
      expect(row.rule).toBe('evaluation-run-summary');
      expect(row.runId).toEqual(expect.any(String));
      expect(row.overall).toMatchObject({ avgScore: expect.any(Number), passRate: expect.any(Number) });
    }
    if (evalFacts.runs.length > 0) {
      expect((withEval.body.data.derived as Record<string, never>).evaluation).toMatchObject({ runs: evalFacts.runs.length, rule: 'server-mean' });
    }

    // 解读独立写入（LLM 层）
    insightSnapshot = { facts: insight.facts, derived: insight.derived, factsHash: insight.factsHash };
    const attached = await api().post(`/api/v1/creative-loop/insights/${insightId}/interpretation`).set(XRW).set('Cookie', cookie)
      .send({ items: ['点击率环比上升 25%，可能与主图对比度提升有关（推测）'], model: 'mock-echo' }).expect(201);
    expect(attached.body.data.interpretation).toMatchObject({
      source: 'llm-interpretation', items: ['点击率环比上升 25%，可能与主图对比度提升有关（推测）'], model: 'mock-echo',
    });
    expect(attached.body.data.facts).toEqual(insightSnapshot.facts);
    expect(attached.body.data.derived).toEqual(insightSnapshot.derived);
    expect(attached.body.data.factsHash).toBe(insightSnapshot.factsHash);

    // DB 行复核：事实层未被解读改写（隔离不变量在存储层同样成立）
    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: insightId } });
    const content = row.content as Record<string, never>;
    expect(content.kind).toBe(INSIGHT_KIND);
    expect(content.facts).toEqual(insightSnapshot.facts);
    expect(content.derived).toEqual(insightSnapshot.derived);
    expect(content.factsHash).toBe(insightSnapshot.factsHash);
    expect((content.interpretation as unknown as Record<string, unknown>).source).toBe('llm-interpretation');

    // 再写一次解读（可覆盖，事实仍不变）
    const again = await api().post(`/api/v1/creative-loop/insights/${insightId}/interpretation`).set(XRW).set('Cookie', cookie)
      .send({ items: ['第二次解读（覆盖）'] }).expect(201);
    expect(again.body.data.interpretation.items).toEqual(['第二次解读（覆盖）']);
    expect(again.body.data.facts).toEqual(insightSnapshot.facts);
    expect(again.body.data.factsHash).toBe(insightSnapshot.factsHash);
  });

  it('② 假设：draft 不可启动 → draft→ready → 启动固化 loop workflow（模板产物，发布 v1，run 锁版本）', async () => {
    const created = await api().post('/api/v1/creative-loop/hypotheses').set(XRW).set('Cookie', cookie)
      .send({ statement, platform: 'mock', projectId, insightId, successCriteria: { metric: 'roas', op: 'gte', value: 1 } })
      .expect(201);
    hypothesisId = created.body.data.id as string;
    hypothesisIds.push(hypothesisId);
    expect(created.body.data).toMatchObject({ status: 'draft', terminal: false });
    expect(created.body.data.organizationId).toEqual(expect.any(String));
    expect(created.body.data.projectId).toBe(projectId);

    // 跨组织引用洞察 → 404（绝不落库）
    await api().post('/api/v1/creative-loop/hypotheses').set(XRW).set('Cookie', cookie)
      .send({ statement, projectId, insightId: randomUUID() }).expect(404);

    // draft 不可启动（状态机唯一裁决：draft → running 非法）
    const refused = await api().post(`/api/v1/creative-loop/hypotheses/${hypothesisId}/start`).set(XRW).set('Cookie', cookie)
      .send({ waitMs: 1500 }).expect(400);
    expect(refused.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.workflow.count({ where: { userId, name: `creative-loop:${hypothesisId}` } })).toBe(0); // 未固化任何定义

    // 提交（draft → ready）
    const ready = await api().post(`/api/v1/creative-loop/hypotheses/${hypothesisId}/status`).set(XRW).set('Cookie', cookie)
      .send({ status: 'ready' }).expect(201);
    expect(ready.body.data.status).toBe('ready');

    const started = await api().post(`/api/v1/creative-loop/hypotheses/${hypothesisId}/start`).set(XRW).set('Cookie', cookie)
      .send({ waitMs: 1500, target }).expect(201);
    loopRunId = started.body.data.run.runId as string;
    runIds.push(loopRunId);
    expect(started.body.data.hypothesis).toMatchObject({ status: 'running' });
    expect(started.body.data.hypothesis.loop).toMatchObject({ runId: loopRunId, attempts: 1 });
    expect(started.body.data.insightId).toBe(insightId);
    expect(started.body.data.insightFactsHash).toBe(insightSnapshot.factsHash);

    // 定义固化 = 模板产物（同输入逐字段一致）+ M9-P4 校验通过 + 组织/项目归属正确
    const wf = await prisma.workflow.findFirstOrThrow({
      where: { userId, name: `creative-loop:${hypothesisId}` },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    workflowIds.push(wf.id);
    loopWorkflowId = wf.id;
    const published = wf.versions.find((v) => v.status === 'published')!;
    expect(published.version).toBe(1);
    expect(published.definition).toEqual(buildLoopDefinition({
      hypothesisId, statement, target, platform: 'mock', insightId, waitMs: 1500,
    }));
    expect(validateDefinition(published.definition as unknown as Parameters<typeof validateDefinition>[0])).toBeNull();
    expect(wf.organizationId).toBe(started.body.data.hypothesis.organizationId);
    expect(wf.projectId).toBe(projectId);

    // run 锁 versionId（版本锁定）+ 幂等：同一假设绝不产生第二个 run
    const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: loopRunId } });
    expect(run.versionId).toBe(published.id);
    expect(run.attempt).toBe(1);
    expect(run.input).toMatchObject({ hypothesisId, insightId, organizationId: wf.organizationId, projectId });
    expect(await prisma.workflowRun.count({ where: { workflowId: wf.id } })).toBe(1);
  });

  it('③ 人工审批门：run 停在 approval（写操作未执行）；生成步骤复用 M5 生成链', async () => {
    const approval = (await waitFor(
      'loop 审批',
      () => prisma.approval.findFirst({ where: { workflowRunId: loopRunId, status: 'requested' } }),
      (a) => a !== null,
    ))!;
    expect(approval.riskLevel).toBe('medium');
    expect(approval.reason).toBe(`创意假设 ${statement}：审批后将向「mock」提交一次平台写操作（success）`);

    const payload = approval.payload as unknown as {
      stepId: string; boundActionType: string; boundAction: Record<string, unknown>;
      form: Record<string, unknown>; __binding: { payloadHash: string };
    };
    expect(payload.stepId).toBe(LOOP_STEP_IDS.humanReview);
    expect(payload.form['input.statement']).toBe(statement);
    const formContent = String(payload.form[`steps.${LOOP_STEP_IDS.generateCreative}.output.content`] ?? '');
    expect(formContent.length).toBeGreaterThan(0);
    // 绑定 = 将被执行的具体动作（含生成结果）；展示字段不参与摘要
    expect(payload.boundActionType).toBe('success');
    expect(payload.boundAction).toMatchObject({ hypothesisId, platform: 'mock', actionType: 'success', creative: formContent });
    expect(payload.__binding.payloadHash).toBe(hashPayload(payload.boundAction));

    // **写操作尚未执行**（无审批 → 绝不产生外部动作）
    expect(await prisma.externalAction.count({
      where: { userId, idempotencyKey: stepExternalActionKey(loopRunId, 3) },
    })).toBe(0);

    // run 让出 lease 等人工（绝不自旋）
    const waiting = await prisma.workflowRun.findUniqueOrThrow({ where: { id: loopRunId } });
    expect(waiting.status).toBe('waiting');
    expect(waiting.waitingOnApprovalId).toBe(approval.id);
    expect(waiting.workerId).toBeNull();

    // 步骤事实：仅前三步被创建；工具步骤 = M7-P8 只读洞察（分层标注）；生成步骤 = 子 AgentRun（M5 生成链）
    const steps = await prisma.workflowStepRun.findMany({ where: { workflowRunId: loopRunId }, orderBy: { stepIndex: 'asc' } });
    expect(steps.map((s) => s.stepId)).toEqual([
      LOOP_STEP_IDS.insightSnapshot, LOOP_STEP_IDS.generateCreative, LOOP_STEP_IDS.humanReview,
    ]);
    const snapshotOutput = steps[0].output as unknown as {
      layering: Record<string, string>; recentPerformance: Array<{ performanceId: string; derived: Record<string, number> }>;
    };
    expect(steps[0].stepType).toBe('tool');
    expect(snapshotOutput.layering).toMatchObject({ recentPerformance: 'service-computed' });
    const mine = snapshotOutput.recentPerformance.find((p) => p.performanceId === perfCurrentId);
    expect(mine?.derived).toMatchObject({ roas: 3 }); // M7-P8 派生公式（服务端计算）

    const childRunId = steps[1].agentRunId!;
    childRunIds.push(childRunId);
    const child = await prisma.agentRun.findUniqueOrThrow({ where: { id: childRunId } });
    expect(child.status).toBe('completed');
    const task = await prisma.generationTask.findFirst({ where: { runId: childRunId } });
    expect(task?.type).toBe('image'); // 复用既有生成链（GenerationTask 事实，不新增生成路径）

    // 状态查询：卡点原因 = 待人工审批（引用 workflowRun）
    const status = await api().get(`/api/v1/creative-loop/hypotheses/${hypothesisId}/status`).set('Cookie', cookie).expect(200);
    expect(status.body.data.pending.reason).toBe('awaiting-approval');
    expect(status.body.data.hypothesis.status).toBe('running');
    expect(status.body.data.run).toMatchObject({ runId: loopRunId, workflowId: loopWorkflowId, version: 1 });
  });

  it('④ approve：外部动作经 M7-P3 全链执行 → wait 观察窗 → run completed；补偿步骤不执行', async () => {
    const approval = await prisma.approval.findFirstOrThrow({ where: { workflowRunId: loopRunId, status: 'requested' } });
    await api().post(`/api/v1/approvals/${approval.id}/approve`).set(XRW).set('Cookie', cookie).expect(201);

    const run = await waitFor(
      'loop run 终态',
      () => prisma.workflowRun.findUniqueOrThrow({ where: { id: loopRunId }, include: { steps: { orderBy: { stepIndex: 'asc' } } } }),
      (r) => ['completed', 'failed', 'timeout'].includes(r.status),
    );
    expect(run.status).toBe('completed');
    expect(run.steps.map((s) => s.stepId)).toEqual([
      LOOP_STEP_IDS.insightSnapshot, LOOP_STEP_IDS.generateCreative, LOOP_STEP_IDS.humanReview,
      LOOP_STEP_IDS.publishCreative, LOOP_STEP_IDS.rollbackPublish, LOOP_STEP_IDS.observePerformance,
      LOOP_STEP_IDS.loopOutcome,
    ]);

    // 写操作经既有 ExternalAction 链（审批 + 幂等键锚点），载荷 = 被审批绑定的动作
    const action = await prisma.externalAction.findUniqueOrThrow({
      where: { userId_provider_idempotencyKey: { userId, provider: 'mock', idempotencyKey: stepExternalActionKey(loopRunId, 3) } },
    });
    expect(action.status).toBe('completed');
    expect(action.approvalId).toBe(approval.id);
    expect(action.input).toMatchObject({ hypothesisId, platform: 'mock', actionType: 'success' });
    const publishStep = run.steps.find((s) => s.stepId === LOOP_STEP_IDS.publishCreative)!;
    expect((publishStep.output as unknown as Record<string, unknown>).externalActionId).toBe(action.id);

    // 补偿步骤：正常流程绝不执行（仅失败回滚链）
    const rollback = run.steps.find((s) => s.stepId === LOOP_STEP_IDS.rollbackPublish)!;
    expect(rollback.status).toBe('skipped');
    expect(rollback.output).toMatchObject({ skipped: true, reason: 'compensation-only step' });

    // wait 观察窗：期限落库 + 真实等待（绝不提前前进）
    const waitStep = run.steps.find((s) => s.stepId === LOOP_STEP_IDS.observePerformance)!;
    expect(waitStep.stepType).toBe('wait');
    const waitOutput = waitStep.output as unknown as { kind: string; waitedMs: number; waitedUntil: string };
    expect(waitOutput.kind).toBe('time');
    expect(Date.parse(waitOutput.waitedUntil)).toBeGreaterThanOrEqual(run.startedAt.getTime());
    expect(waitOutput.waitedMs).toBeGreaterThanOrEqual(1_400); // 观察窗真实等待（绝不提前前进）

    // 终态输出：引用前序步骤事实（loop_outcome）
    expect(run.output).toMatchObject({ hypothesisId, insightId, published: action.id, observedMs: 1_500 });
    expect(String((run.output as unknown as Record<string, unknown>).generated).length).toBeGreaterThan(0);

    // 运行明细（引用 workflowRun；生命周期仍归 M7-P6）
    const detail = await api().get(`/api/v1/creative-loop/hypotheses/${hypothesisId}/run`).set('Cookie', cookie).expect(200);
    expect(detail.body.data.run).toMatchObject({ runId: loopRunId, status: 'completed', version: 1 });
    expect(detail.body.data.run.steps).toHaveLength(7);
    expect(detail.body.data.pending.reason).toBe('awaiting-facts'); // 尚未回流 → 绝不臆断
  });

  it('⑤ 判据收敛：回流事实后读路径按判据自动 validated（条件更新 + 历史可审计）', async () => {
    const before = await api().get(`/api/v1/creative-loop/hypotheses/${hypothesisId}/status`).set('Cookie', cookie).expect(200);
    expect(before.body.data.hypothesis.status).toBe('running');
    expect(before.body.data.hypothesis.verdict).toBeNull();
    expect(before.body.data.pending.reason).toBe('awaiting-facts');

    // 回流（loop 启动后捕获）→ 满足判据 roas >= 1
    await prisma.creativePerformance.create({
      data: {
        userId, projectId, platform: 'mock',
        periodStart: new Date(), periodEnd: new Date(),
        impressions: 500, clicks: 40, spend: 100, conversions: 4, revenue: 400, orders: 4,
        capturedAt: new Date(),
      },
    });
    const after = await api().get(`/api/v1/creative-loop/hypotheses/${hypothesisId}/status`).set('Cookie', cookie).expect(200);
    const hypothesis = after.body.data.hypothesis as Record<string, never>;
    expect(hypothesis.status).toBe('validated');
    expect(hypothesis.terminal).toBe(true);
    expect(hypothesis.verdict).toMatchObject({ decision: 'validated', decidedBy: 'criteria' });
    expect((hypothesis.verdict as unknown as Record<string, never>).facts).toMatchObject({
      performance: { rows: 1, derived: { roas: 4 }, rule: 'server-sum' },
    });
    expect((hypothesis.history as unknown as Array<Record<string, string>>).map((h) => [h.from, h.to, h.by])).toEqual([
      ['draft', 'ready', 'manual'], ['ready', 'running', 'manual'], ['running', 'validated', 'criteria'],
    ]);
    expect(after.body.data.pending.reason).toBeNull();

    // 终态只读：编辑/删除/再推进一律拒绝（绝不复活）
    await api().patch(`/api/v1/creative-loop/hypotheses/${hypothesisId}`).set(XRW).set('Cookie', cookie)
      .send({ statement: '终态不可改' }).expect(400);
    await api().post(`/api/v1/creative-loop/hypotheses/${hypothesisId}/status`).set(XRW).set('Cookie', cookie)
      .send({ status: 'rejected' }).expect(400);
    await api().delete(`/api/v1/creative-loop/hypotheses/${hypothesisId}`).set(XRW).set('Cookie', cookie).expect(400);
    const stable = await prisma.artifact.findUniqueOrThrow({ where: { id: hypothesisId } });
    const stableDoc = stable.content as { status: string; history: unknown[] };
    expect(stableDoc.status).toBe('validated');
    expect(stableDoc.history).toHaveLength(3); // draft→ready, ready→running, running→validated

    // 洞察事实层未被闭环后续动作改写（解读隔离在闭环全程保持）
    const insight = await api().get(`/api/v1/creative-loop/insights/${insightId}`).set('Cookie', cookie).expect(200);
    expect(insight.body.data.facts).toEqual(insightSnapshot.facts);
    expect(insight.body.data.derived).toEqual(insightSnapshot.derived);
    expect(insight.body.data.factsHash).toBe(insightSnapshot.factsHash);
  });

  it('⑥ 拒绝审批：写操作绝不执行 + 假设按 run 终态系统驳回（decidedBy=system）', async () => {
    const h2 = await createHypothesis({
      statement: '第二假设：深色背景主图可提升转化率',
      successCriteria: { metric: 'roas', op: 'gte', value: 1 },
    });
    await api().post(`/api/v1/creative-loop/hypotheses/${h2}/status`).set(XRW).set('Cookie', cookie)
      .send({ status: 'ready' }).expect(201);
    const started = await api().post(`/api/v1/creative-loop/hypotheses/${h2}/start`).set(XRW).set('Cookie', cookie)
      .send({ waitMs: 500 }).expect(201);
    const runId = started.body.data.run.runId as string;
    runIds.push(runId);

    const approval = (await waitFor(
      '第二 loop 审批',
      () => prisma.approval.findFirst({ where: { workflowRunId: runId, status: 'requested' } }),
      (a) => a !== null,
    ))!;
    await api().post(`/api/v1/approvals/${approval.id}/reject`).set(XRW).set('Cookie', cookie).expect(201);

    const run = await waitFor(
      '第二 run 终态',
      () => prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } }),
      (r) => ['completed', 'failed', 'timeout'].includes(r.status),
    );
    expect(run.status).toBe('failed');
    // **写操作绝不执行**（无审批放行 → 无外部动作行）
    expect(await prisma.externalAction.count({
      where: { userId, idempotencyKey: stepExternalActionKey(runId, 3) },
    })).toBe(0);

    const status = await api().get(`/api/v1/creative-loop/hypotheses/${h2}/status`).set('Cookie', cookie).expect(200);
    expect(status.body.data.hypothesis.status).toBe('rejected');
    expect(status.body.data.hypothesis.verdict).toMatchObject({ decision: 'rejected', decidedBy: 'system' });
    expect(String(status.body.data.hypothesis.verdict.reason)).toContain('failed');
    expect(status.body.data.pending.reason).toBeNull();
  });

  it('⑦ 条件更新：并发推进恰好一次；并发启动绝不产生第二个 run；cancelled 不自动终态化', async () => {
    const h3 = await createHypothesis({ statement: '第三假设：竖版主图可提升移动端点击率' });

    // 并发提交：两个请求都基于 draft 读取 → 条件更新只有一个赢家（输家 400，绝不覆盖）
    const [a, b] = await Promise.all([
      api().post(`/api/v1/creative-loop/hypotheses/${h3}/status`).set(XRW).set('Cookie', cookie).send({ status: 'ready' }),
      api().post(`/api/v1/creative-loop/hypotheses/${h3}/status`).set(XRW).set('Cookie', cookie).send({ status: 'ready' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
    const afterRace = await prisma.artifact.findUniqueOrThrow({ where: { id: h3 } });
    expect((afterRace.content as { status: string; history: unknown[] }).status).toBe('ready');
    expect((afterRace.content as { history: unknown[] }).history).toHaveLength(1);

    // 并发启动：workflow 并发创建收敛为最早一行 + 幂等键相同 → 绝不产生第二个 run；
    // 两个请求都收到 201 且指向**同一个 run**（双击的确定性结果，绝不是两个 run）
    const [s1, s2] = await Promise.all([
      api().post(`/api/v1/creative-loop/hypotheses/${h3}/start`).set(XRW).set('Cookie', cookie).send({ waitMs: 500 }),
      api().post(`/api/v1/creative-loop/hypotheses/${h3}/start`).set(XRW).set('Cookie', cookie).send({ waitMs: 500 }),
    ]);
    expect([s1.status, s2.status]).toEqual([201, 201]);
    const wfRows = await prisma.workflow.findMany({
      where: { userId, name: `creative-loop:${h3}` },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(wfRows).toHaveLength(1); // 并发创建的重复行已被落败方删除（未挂 run，删除安全）
    const wf3 = wfRows[0];
    workflowIds.push(wf3.id);
    const runs3 = await prisma.workflowRun.findMany({ where: { workflowId: wf3.id } });
    expect(runs3).toHaveLength(1);
    const runId3 = runs3[0].id;
    runIds.push(runId3);
    for (const r of [s1, s2]) expect(r.body.data.run.runId).toBe(runId3); // 两个响应收敛到同一 run
    const doc3 = await prisma.artifact.findUniqueOrThrow({ where: { id: h3 } });
    const doc3Content = doc3.content as { status: string; loop: { attempts: number }; history: Array<Record<string, string>> };
    expect(doc3Content.status).toBe('running');
    expect(doc3Content.loop.attempts).toBe(1);
    expect(doc3Content.history.map((h) => [h.from, h.to])).toEqual([['draft', 'ready'], ['ready', 'running']]);

    // 取消 run（运维动作）→ 假设**绝不自动终态化**，判定留给人
    await waitFor(
      '第三 loop 审批',
      () => prisma.approval.findFirst({ where: { workflowRunId: runId3, status: 'requested' } }),
      (x) => x !== null,
    );
    await api().post(`/api/v1/workflows/runs/${runId3}/cancel`).set(XRW).set('Cookie', cookie).expect(201);
    await waitFor('第三 run cancelled', () => prisma.workflowRun.findUniqueOrThrow({ where: { id: runId3 } }), (r) => r.status === 'cancelled');

    const pending = await api().get(`/api/v1/creative-loop/hypotheses/${h3}/status`).set('Cookie', cookie).expect(200);
    expect(pending.body.data.hypothesis.status).toBe('running');
    expect(pending.body.data.pending.reason).toBe('cancelled-needs-verdict');

    // 人工判定（显式 decision）
    const concluded = await api().post(`/api/v1/creative-loop/hypotheses/${h3}/conclude`).set(XRW).set('Cookie', cookie)
      .send({ decision: 'rejected', reason: '取消后人工判定：证据不足' }).expect(201);
    expect(concluded.body.data.hypothesis.status).toBe('rejected');
    expect(concluded.body.data.hypothesis.verdict).toMatchObject({ decidedBy: 'manual', reason: '取消后人工判定：证据不足' });

    // 删除：draft/rejected 可删（本假设已取消 + 人工判定为 rejected）；running/validated 拒绝删除的语义在单测覆盖
    await api().delete(`/api/v1/creative-loop/hypotheses/${h3}`).set(XRW).set('Cookie', cookie).expect(200);
    expect(await prisma.artifact.count({ where: { id: h3 } })).toBe(0); // 确实删除（含状态条件更新谓词）
    hypothesisIds.splice(hypothesisIds.indexOf(h3), 1);
  });

  it('⑧ 租户隔离：非成员一律 404（防枚举），绝不因知道 id 而放行', async () => {
    await api().get(`/api/v1/creative-loop/hypotheses/${hypothesisId}`).set('Cookie', outsiderCookie).expect(404);
    await api().patch(`/api/v1/creative-loop/hypotheses/${hypothesisId}`).set(XRW).set('Cookie', outsiderCookie)
      .send({ statement: '越权改写' }).expect(404);
    await api().post(`/api/v1/creative-loop/hypotheses/${hypothesisId}/status`).set(XRW).set('Cookie', outsiderCookie)
      .send({ status: 'ready' }).expect(404);
    await api().post(`/api/v1/creative-loop/hypotheses/${hypothesisId}/start`).set(XRW).set('Cookie', outsiderCookie)
      .send({}).expect(404);
    await api().get(`/api/v1/creative-loop/insights/${insightId}`).set('Cookie', outsiderCookie).expect(404);
    await api().post(`/api/v1/creative-loop/insights/${insightId}/interpretation`).set(XRW).set('Cookie', outsiderCookie)
      .send({ items: ['越权解读'] }).expect(404);
    await api().get(`/api/v1/creative-loop/hypotheses/${hypothesisId}/run`).set('Cookie', outsiderCookie).expect(404);

    // 事实未被越权请求改写
    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: hypothesisId } });
    expect((row.content as { status: string }).status).toBe('validated');
    expect((row.content as { statement: string }).statement).toBe(statement);
  });

  it('⑨ 不可见性：创意闭环文档绝不进入用户制品列表（Artifact 容器隔离）', async () => {
    // 闭环文档（假设/洞察）以 Artifact 承载，但 conversationId=null/storageKey=null 且 kind 判别——
    // 既有制品读路径（会话制品列表）绝不应看到它们。
    const rows = await prisma.artifact.findMany({ where: { id: { in: [...hypothesisIds, ...insightIds] } } });
    expect(rows).toHaveLength(hypothesisIds.length + insightIds.length);
    for (const row of rows) {
      const kind = (row.content as { kind?: string }).kind;
      expect([HYPOTHESIS_KIND, INSIGHT_KIND]).toContain(kind);
      expect(row.conversationId).toBeNull();
      expect(row.storageKey).toBeNull();
    }
  });
});
