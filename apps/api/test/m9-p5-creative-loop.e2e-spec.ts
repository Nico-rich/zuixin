import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Queue } from 'bullmq';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WORKFLOW_QUEUE } from '../src/core/queue/queue.module';
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
import {
  BACKFILL_BATCH_SIZE, HYPOTHESIS_KIND, INSIGHT_KIND, HypothesisStore, InsightStore,
} from '../src/modules/creative-loop/creative-loop-store';
import { FeedbackService } from '../src/modules/feedback/feedback.service';
import { AGENT_PERFORMANCE_TOOL, factsHashOf } from '../src/modules/creative-loop/insight-rules';

/**
 * M9-P5 Creative Performance Loop e2e（真实 PostgreSQL/Redis/BullMQ + Worker 进程内实例）。
 *
 * 运行方式（**独立 Redis DB，与其他 e2e 的 db 0/8/9 隔离**）：
 *   cd apps/api && REDIS_URL=redis://localhost:6379/24 npx vitest run test/m9-p5-creative-loop.e2e-spec.ts
 *
 * 覆盖（闭环全程，**只复用既有系统，绝不新建第二套**）：
 *   ① 洞察：事实/派生层服务端计算（Feedback + CreativePerformance + M9-P1 摘要）+ 分层标注；
 *      LLM 解读独立写入 → facts/derived/factsHash **逐字节不变**（专表行复核）。
 *   ② 假设状态机：draft 不可启动 loop；draft→ready 后可启动；固化定义 = 模板产物且发布为 v1（版本锁定）。
 *   ③ 人工审批门：run 停在 approval（**写操作尚未执行**）；审批绑定摘要 = 将被执行的动作；生成步骤复用 M5 生成链。
 *   ④ approve → 外部动作（M7-P3 全链：审批 + 幂等键）→ wait 观察窗 → run completed；补偿步骤正常流程不执行。
 *   ⑤ 判据收敛：事实未回流 → 绝不臆断（awaiting-facts）；回流后读路径按判据自动 validated（条件更新）。
 *   ⑥ 拒绝审批 → 写操作**绝不执行** + 假设按 run 终态系统驳回；补偿链被真实评估且**无可补偿步骤**（未发布）。
 *   ⑥b P5 补偿链**真实执行**：已发布后步骤失败 → 逆序补偿链调用 rollback_publish（幂等锚点下标的
 *      外部动作）→ 审批绑定校验**闭锁拒绝**（绝不落第二条外部动作）→ run.output.compensation 留痕
 *      → 模块把"已发布未回滚"作为事实回报（verdict.facts.rollback + status.rollback）。
 *   ⑦ 条件更新：并发状态推进恰好一个成功；并发启动绝不产生第二个 run；取消 run 不自动终态化 + 人工判定。
 *   ⑦b M11-P5/D2-02：状态 CAS 带 **version 谓词**——并发"编辑 + 状态推进"绝不互相静默覆盖
 *      （成功次数与版本前移逐一对应；赢家的写入完整保留，输家 400 不落库）。
 *   ⑧ 租户隔离：非成员一律 404（防枚举），绝不因知道 id 而放行。
 *   ⑨ 存储隔离：假设/洞察落在**专表**（CreativeHypothesis/CreativeInsight），绝不进入 `Artifact` 容器
 *      （既无"制品列表污染"风险，也无需 conversationId/storageKey 空值兜底）。
 *   ⑩ M11-P5/D2-01：旧容器行存量回填在**真实 PG** 上按主键游标**分批**（跨批不丢行）、幂等、只读不删。
 *   ⑪ M12-P1 来源判别（审计 R1）：`performance.capture` 是 agent 可写工具——走**真实 agent 工具路径**
 *      （AgentRun → AgentRunStep → ToolCall 账本 → FeedbackService 写副作用）伪造高 ROAS 绩效，
 *      判定窗口必须**排除 agent 来源行**（排除计数留痕），绝不据伪造绩效自证 validated；
 *      外部行回流后才按判据成立（derived 只含外部行）。
 *   ⑫ M12-P1 verdict→下一次决策桥：既有 verdict 进入新洞察的事实层（只读引用 + 来源标注），
 *      同 statement 新假设在 create 响应带上历史判定先例（**绝不落库**、绝不预判、绝不改写历史行）。
 *
 * 说明：M10-P4 起假设/洞察写入 creative-loop 专表（organizationId 直列，查询一律 server-side scope）；
 * 历史 `Artifact(type='other')` 行由 store 层**首次访问幂等回填**（本 spec 不再产生这类行）。
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
  const legacyArtifactIds: string[] = [];
  const workflowIds: string[] = [];
  const runIds: string[] = [];
  const childRunIds: string[] = [];
  const extraUserIds: string[] = [];
  /** M12-P1 来源判别用例的 agent 事实链（删除 run 级联 steps/toolCalls） */
  const agentRunIds: string[] = [];

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
    // 闭环专表（按 id 精确删除；已删除的行 count=0 无副作用；含回填用例搬入的旧容器行）
    await prisma.creativeInsight.deleteMany({
      where: { id: { in: [...insightIds, ...legacyArtifactIds] } },
    }).catch(() => undefined);
    await prisma.creativeHypothesis.deleteMany({
      where: { id: { in: [...hypothesisIds, ...legacyArtifactIds] } },
    }).catch(() => undefined);
    await prisma.artifact.deleteMany({ where: { id: { in: legacyArtifactIds } } }).catch(() => undefined);
    // M12-P1 来源判别用例的 agent 侧事实链（AgentRun 级联 steps/toolCalls）+ 工具路径写入的快照
    await prisma.agentRun.deleteMany({ where: { id: { in: agentRunIds } } }).catch(() => undefined);
    await prisma.performanceSnapshot.deleteMany({ where: { userId, projectId } }).catch(() => undefined);
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

    // DB 行复核（专表列）：事实层未被解读改写（隔离不变量在存储层同样成立）
    const row = await prisma.creativeInsight.findUniqueOrThrow({ where: { id: insightId } });
    expect(row.organizationId).toEqual(expect.any(String)); // 组织隔离 = 直列（server-side scope）
    expect(row.projectId).toBe(projectId);
    expect(row.userId).toBe(userId);
    expect(row.facts).toEqual(insightSnapshot.facts);
    expect(row.derived).toEqual(insightSnapshot.derived);
    expect(row.factsHash).toBe(insightSnapshot.factsHash);
    expect(row.layering).toEqual({ facts: 'service-computed', derived: 'service-computed', interpretation: 'llm-interpretation' });
    expect((row.interpretation as unknown as Record<string, unknown>).source).toBe('llm-interpretation');
    expect(row.version).toBe(2); // 建行 v1 + 一次解读写入（factsHash CAS 锚定 + version 前移）

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
    expect(created.body.data.kind).toBe(HYPOTHESIS_KIND);
    expect(created.body.data.organizationId).toEqual(expect.any(String));
    expect(created.body.data.projectId).toBe(projectId);

    // 专表落库（M10-P4）：组织直列 + 版本锚点（非状态字段更新走 version CAS）
    const createdRow = await prisma.creativeHypothesis.findUniqueOrThrow({ where: { id: hypothesisId } });
    expect(createdRow).toMatchObject({ status: 'draft', statement, platform: 'mock', version: 1 });
    expect(createdRow.organizationId).toBe(created.body.data.organizationId);
    expect(createdRow.history).toHaveLength(0);

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

    // run 让出 lease 等人工（绝不自旋）——approval 行先落库、run 状态随后转 waiting：
    // 断言最终一致的事实（瞬态读会随机看到 running，M11-P5 顺手消除该 flake）
    const waiting = await waitFor(
      'loop run 让出 lease',
      () => prisma.workflowRun.findUniqueOrThrow({ where: { id: loopRunId } }),
      (r) => r.status === 'waiting',
    );
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
    const stable = await prisma.creativeHypothesis.findUniqueOrThrow({ where: { id: hypothesisId } });
    expect(stable.status).toBe('validated');
    expect((stable.history as unknown as unknown[])).toHaveLength(3); // draft→ready, ready→running, running→validated
    expect(stable.verdict).toMatchObject({ decision: 'validated', decidedBy: 'criteria' });
    expect(stable.loop).toMatchObject({ runId: loopRunId, attempts: 1 });

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
      () => prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, include: { steps: { orderBy: { stepIndex: 'asc' } } } }),
      (r) => ['completed', 'failed', 'timeout'].includes(r.status),
    );
    expect(run.status).toBe('failed');
    // **写操作绝不执行**（无审批放行 → 无外部动作行）
    expect(await prisma.externalAction.count({
      where: { userId, idempotencyKey: stepExternalActionKey(runId, 3) },
    })).toBe(0);

    // 补偿链被**真实评估**：run 失败于审批步骤（index 2），未执行任何写操作 → 无可补偿步骤
    // （计划为空 → 绝不写 run.output.compensation、绝不产生回滚锚点行/回滚外部动作）
    expect(run.currentStep).toBe(2);
    expect(run.steps.map((s) => [s.stepIndex, s.stepId])).toEqual([
      [0, LOOP_STEP_IDS.insightSnapshot], [1, LOOP_STEP_IDS.generateCreative], [2, LOOP_STEP_IDS.humanReview],
    ]);
    expect(run.steps.some((s) => s.stepType === 'compensation')).toBe(false);
    expect(await prisma.workflowStepRun.count({ where: { workflowRunId: runId, stepType: 'compensation' } })).toBe(0);
    expect((run.output ?? null)).toBeNull(); // 无补偿声明命中 → 不写终态 output（既有语义）
    expect(await prisma.externalAction.count({
      where: { userId, idempotencyKey: { in: [stepExternalActionKey(runId, 3), stepExternalActionKey(runId, 4)] } },
    })).toBe(0);

    const status = await api().get(`/api/v1/creative-loop/hypotheses/${h2}/status`).set('Cookie', cookie).expect(200);
    expect(status.body.data.hypothesis.status).toBe('rejected');
    expect(status.body.data.hypothesis.verdict).toMatchObject({ decision: 'rejected', decidedBy: 'system' });
    expect(String(status.body.data.hypothesis.verdict.reason)).toContain('failed');
    expect(status.body.data.pending.reason).toBeNull();
    // 回滚投影：从未发布 → not-required（且判决缘由不提"未回滚"）
    expect(status.body.data.rollback).toMatchObject({ required: false, status: 'not-required', publishActionId: null });
    expect(String(status.body.data.hypothesis.verdict.reason)).not.toContain('未回滚');
  });

  it('⑥b P5 补偿链真实执行：已发布后失败 → rollback_publish 被真实调用（闭锁拒绝 + 锚点留痕 + 事实回报）', async () => {
    const h4 = await createHypothesis({
      statement: '第四假设：暖色背景主图可提升加购率',
      successCriteria: { metric: 'roas', op: 'gte', value: 1 },
    });
    await api().post(`/api/v1/creative-loop/hypotheses/${h4}/status`).set(XRW).set('Cookie', cookie)
      .send({ status: 'ready' }).expect(201);
    // 观察窗取长值：本用例在**观察窗期间**构造失败残留（窗口到期由延迟作业唤醒，绝不参与本用例判定）
    const started = await api().post(`/api/v1/creative-loop/hypotheses/${h4}/start`).set(XRW).set('Cookie', cookie)
      .send({ waitMs: 30_000 }).expect(201);
    const runId = started.body.data.run.runId as string;
    runIds.push(runId);

    // 审批放行 → publish_creative 经 M7-P3 全链执行（**平台写操作既成事实**）
    const approval = (await waitFor(
      '第四 loop 审批',
      () => prisma.approval.findFirst({ where: { workflowRunId: runId, status: 'requested' } }),
      (a) => a !== null,
    ))!;
    await api().post(`/api/v1/approvals/${approval.id}/approve`).set(XRW).set('Cookie', cookie).expect(201);
    await waitFor(
      '第四 run 进入观察窗（发布已完成）',
      () => prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, include: { steps: { orderBy: { stepIndex: 'asc' } } } }),
      (r) => r.status === 'waiting'
        && r.steps.find((s) => s.stepId === LOOP_STEP_IDS.publishCreative)?.status === 'completed',
    );
    const publishAction = await prisma.externalAction.findUniqueOrThrow({
      where: { userId_provider_idempotencyKey: { userId, provider: 'mock', idempotencyKey: stepExternalActionKey(runId, 3) } },
    });
    expect(publishAction.status).toBe('completed');

    // 构造 M9-P4 ③ 的**失败残留**输入状态（引擎显式支持并幂等补做补偿链的分支）：
    // loop 定义在 publish 之后没有可失败步骤（rollback 是 compensation-only、wait 是时间窗、output 不失败），
    // 故按引擎的恢复路径注入——观察窗步骤行已被原执行者标记 failed（崩溃于补偿/终态写入之前），
    // 随后 run 被重新投递 → 引擎必须**幂等补做逆序补偿链**（绝不重执行已完成的发布副作用）。
    await prisma.workflowStepRun.update({
      where: { workflowRunId_stepIndex: { workflowRunId: runId, stepIndex: 5 } },
      data: { status: 'failed', errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'e2e：观察窗读取超时（失败残留注入）' },
    });
    await prisma.workflowRun.update({
      where: { id: runId },
      data: {
        status: 'queued', currentStep: 5, workerId: null, leaseUntil: null, heartbeatAt: null,
        waitingOnApprovalId: null, waitingOnAgentRunId: null, completedAt: null, errorCode: null, errorMessage: null,
      },
    });
    const queue = app.get<Queue>(getQueueToken(WORKFLOW_QUEUE));
    await queue.add('execute', { runId }, {
      jobId: `m9p5-compensate-${runId}`, attempts: 1, removeOnComplete: true, removeOnFail: { count: 500 },
    });

    const failed = await waitFor(
      '第四 run 补偿后终态',
      () => prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, include: { steps: { orderBy: { stepIndex: 'asc' } } } }),
      (r) => r.status === 'failed',
    );
    expect(failed.errorCode).toBe('PROVIDER_TIMEOUT'); // 终态归因 = 触发补偿链的失败

    // **补偿链真实执行**：run.output.compensation 记录 rollback_publish 的调用结果（绝不静默跳过）
    expect(failed.output).toMatchObject({
      compensation: [{
        stepId: LOOP_STEP_IDS.publishCreative, compensateStepId: LOOP_STEP_IDS.rollbackPublish,
        stepIndex: 4, status: 'failed', errorCode: 'APPROVAL_BINDING_MISMATCH',
      }],
    });
    // 锚点行 = 定义中的回滚步骤下标（行复用，stepType 留痕 'compensation'；绝不新建第二行）
    const anchor = failed.steps.find((s) => s.stepIndex === 4)!;
    expect(anchor.stepId).toBe(LOOP_STEP_IDS.rollbackPublish);
    expect(anchor.stepType).toBe('compensation');
    expect(anchor.status).toBe('failed');
    expect(anchor.errorCode).toBe('APPROVAL_BINDING_MISMATCH');
    expect(await prisma.workflowStepRun.count({ where: { workflowRunId: runId, stepIndex: 4 } })).toBe(1);

    // 闭锁拒绝（fail-closed）：授权校验先于行创建 → **绝不产生第二条平台写操作**
    // （引擎只认 run 内最早一条已完成审批 = 发布所绑定者，故回滚动作无法获得授权——见结算报告"依赖/A5"）
    expect(await prisma.externalAction.count({
      where: { userId, idempotencyKey: stepExternalActionKey(runId, 4) },
    })).toBe(0);
    const publishAfter = await prisma.externalAction.findUniqueOrThrow({ where: { id: publishAction.id } });
    expect(publishAfter.status).toBe('completed'); // 已发布的写操作**未被篡改/未重复执行**

    // 模块如实回报："已发布未回滚"是事实（绝非默认已回滚）
    const status = await api().get(`/api/v1/creative-loop/hypotheses/${h4}/status`).set('Cookie', cookie).expect(200);
    expect(status.body.data.hypothesis.status).toBe('rejected');
    expect(status.body.data.hypothesis.verdict).toMatchObject({
      decidedBy: 'system',
      reason: expect.stringContaining('已发布的写操作未回滚'),
      facts: { publishActionId: publishAction.id, rollback: 'failed' },
    });
    expect(status.body.data.rollback).toMatchObject({
      required: true, status: 'failed', publishActionId: publishAction.id,
      compensateStepId: LOOP_STEP_IDS.rollbackPublish, errorCode: 'APPROVAL_BINDING_MISMATCH',
    });
    const detail = await api().get(`/api/v1/creative-loop/hypotheses/${h4}/run`).set('Cookie', cookie).expect(200);
    expect(detail.body.data.rollback).toMatchObject({ required: true, status: 'failed', publishActionId: publishAction.id });

    // 崩溃重放（补偿已记录、终态写入前再次崩溃）：锚点行 attempt 前移、链**幂等补做**，
    // 副作用仍 exactly-once（同一幂等键 + 闭锁拒绝先于行创建 → 外部动作行数恒为 0）
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: 'queued', workerId: null, leaseUntil: null, heartbeatAt: null, completedAt: null },
    });
    await queue.add('execute', { runId }, {
      jobId: `m9p5-compensate-replay-${runId}`, attempts: 1, removeOnComplete: true, removeOnFail: { count: 500 },
    });
    await waitFor(
      '第四 run 重放后仍为 failed',
      () => prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } }),
      (r) => r.status === 'failed' && r.workerId === null,
    );
    const replayedAnchor = await prisma.workflowStepRun.findUniqueOrThrow({
      where: { workflowRunId_stepIndex: { workflowRunId: runId, stepIndex: 4 } },
    });
    // 正常流程 skip 时 attempt=1 → 首次补偿 attempt=2 → 重放补做 attempt=3（同一锚点行前移，绝不新建第二行）
    expect(replayedAnchor.attempt).toBe(3);
    expect(replayedAnchor.stepType).toBe('compensation');
    expect(await prisma.workflowStepRun.count({ where: { workflowRunId: runId, stepIndex: 4 } })).toBe(1);
    expect(await prisma.externalAction.count({
      where: { userId, idempotencyKey: stepExternalActionKey(runId, 4) },
    })).toBe(0);
  });

  it('⑦ 条件更新：并发推进恰好一次；并发启动绝不产生第二个 run；cancelled 不自动终态化', async () => {
    const h3 = await createHypothesis({ statement: '第三假设：竖版主图可提升移动端点击率' });

    // 并发提交：两个请求都基于 draft 读取 → 条件更新只有一个赢家（输家 400，绝不覆盖）
    const [a, b] = await Promise.all([
      api().post(`/api/v1/creative-loop/hypotheses/${h3}/status`).set(XRW).set('Cookie', cookie).send({ status: 'ready' }),
      api().post(`/api/v1/creative-loop/hypotheses/${h3}/status`).set(XRW).set('Cookie', cookie).send({ status: 'ready' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
    const afterRace = await prisma.creativeHypothesis.findUniqueOrThrow({ where: { id: h3 } });
    expect(afterRace.status).toBe('ready');
    expect((afterRace.history as unknown as unknown[])).toHaveLength(1);
    expect(afterRace.version).toBe(2); // v1 建行 + 一次状态 CAS（version 随状态推进前移）

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
    const doc3 = await prisma.creativeHypothesis.findUniqueOrThrow({ where: { id: h3 } });
    const doc3Loop = doc3.loop as unknown as { attempts: number };
    expect(doc3.status).toBe('running');
    expect(doc3Loop.attempts).toBe(1);
    expect((doc3.history as unknown as Array<Record<string, string>>).map((h) => [h.from, h.to]))
      .toEqual([['draft', 'ready'], ['ready', 'running']]);

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
    expect(await prisma.creativeHypothesis.count({ where: { id: h3 } })).toBe(0); // 确实删除（含状态条件更新谓词）
    hypothesisIds.splice(hypothesisIds.indexOf(h3), 1);
  });

  it('⑦b 状态 CAS 带 version 谓词：并发编辑 + 状态推进绝不互相静默覆盖（D2-02 lost update）', async () => {
    // 并发"编辑陈述"（version CAS）与"提交 draft→ready"（status CAS）。旧实现只锚定 status：
    // 状态推进会把**读取时的旧快照**（旧陈述）一并写回，两名选手都返回 201 → 编辑被静默吞掉。
    for (let round = 0; round < 3; round++) {
      const h = await createHypothesis({ statement: `并发对照假设 ${round}` });
      const newStatement = `并发编辑后的陈述 ${round}`;
      const [patched, advanced] = await Promise.all([
        api().patch(`/api/v1/creative-loop/hypotheses/${h}`).set(XRW).set('Cookie', cookie).send({ statement: newStatement }),
        api().post(`/api/v1/creative-loop/hypotheses/${h}/status`).set(XRW).set('Cookie', cookie).send({ status: 'ready' }),
      ]);
      expect([200, 400]).toContain(patched.status); // PATCH 成功 200 / 冲突 400
      expect([201, 400]).toContain(advanced.status); // 状态推进成功 201 / 冲突 400
      const winners = (patched.status === 200 ? 1 : 0) + (advanced.status === 201 ? 1 : 0);
      const row = await prisma.creativeHypothesis.findUniqueOrThrow({ where: { id: h } });
      expect(row.version).toBe(1 + winners); // 每次成功写入恰好前移一版（绝不"报成功却没写"）
      expect((row.history as unknown as unknown[]).length).toBe(row.status === 'ready' ? 1 : 0);
      if (winners === 2) {
        // 两个写入完全串行：后写者读到的是**最新快照** → 编辑内容必须保留在最终行里
        expect(row.status).toBe('ready');
        expect(row.statement).toBe(newStatement);
      } else if (row.status === 'ready') {
        expect(row.statement).toBe(`并发对照假设 ${round}`); // 状态推进赢 → 编辑 400 且未落库
      } else {
        expect(row.statement).toBe(newStatement); // 编辑赢 → 状态推进 400 且未落库
      }
    }
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
    const row = await prisma.creativeHypothesis.findUniqueOrThrow({ where: { id: hypothesisId } });
    expect(row.status).toBe('validated');
    expect(row.statement).toBe(statement);
  });

  it('⑨ 存储隔离：假设/洞察只在专表，绝不进入 Artifact 容器（无制品列表污染路径）', async () => {
    // M10-P4 起闭环文档写专表：既无 conversationId/storageKey 空值兜底，也不与用户制品共表——
    // 既有制品读路径（会话制品列表/按 kind 扫描）在结构上就不可能看到它们。
    const hypotheses = await prisma.creativeHypothesis.findMany({ where: { id: { in: hypothesisIds } } });
    expect(hypotheses).toHaveLength(hypothesisIds.length);
    const insights = await prisma.creativeInsight.findMany({ where: { id: { in: insightIds } } });
    expect(insights).toHaveLength(insightIds.length);

    // 专表行有组织直列（server-side scope 的前提），且旧容器零残留
    for (const h of hypotheses) expect(h.organizationId).toEqual(expect.any(String));
    for (const i of insights) expect(i.organizationId).toEqual(expect.any(String));
    expect(await prisma.artifact.count({ where: { id: { in: [...hypothesisIds, ...insightIds] } } })).toBe(0);

    // 列表读路径（专表）按组织/项目 server-side 过滤：本项目的假设可见，且不含其它组织的行
    const listed = await api().get(`/api/v1/creative-loop/hypotheses?projectId=${projectId}&limit=50`).set('Cookie', cookie).expect(200);
    const listedIds = (listed.body.data.hypotheses as Array<{ id: string; organizationId: string }>);
    for (const row of listedIds) {
      const stored = hypotheses.find((h) => h.id === row.id);
      if (stored) expect(row.organizationId).toBe(stored.organizationId);
    }
  });

  it('⑩ 存量回填（真实 PG）：旧 Artifact 行按主键游标**分批**搬入专表（跨批不丢行），幂等且只读不删', async () => {
    const orgId = (await prisma.creativeHypothesis.findUniqueOrThrow({ where: { id: hypothesisId } })).organizationId;
    const total = BACKFILL_BATCH_SIZE + 1; // **跨两批**：末批 1 行（游标分页边界）
    const ids = Array.from({ length: total }, (_, i) =>
      `e2e-m9p5-legacy-${randomUUID().slice(0, 8)}-${String(i).padStart(4, '0')}`);
    await prisma.artifact.createMany({
      data: ids.map((id, i) => ({
        id,
        userId,
        projectId,
        type: 'other' as never,
        title: 'legacy creative loop container',
        createdAt: new Date('2025-01-01T00:00:00Z'),
        content: i === total - 1
          ? { kind: INSIGHT_KIND, organizationId: orgId, projectId, factsHash: 'legacy-hash' } // 末行：洞察 kind
          : { kind: HYPOTHESIS_KIND, organizationId: orgId, projectId, status: 'draft', statement: `历史假设 ${i}` },
      })),
    });
    legacyArtifactIds.push(...ids);

    // 独立 store key = 等价于"新进程首次访问"（绕开 e2e 应用实例的进程内记忆化，触发真实回填）
    const deps = {
      artifact: prisma.artifact,
      creativeHypothesis: prisma.creativeHypothesis,
      creativeInsight: prisma.creativeInsight,
    };
    const freshStore = () => new HypothesisStore(deps as never);
    const freshInsightStore = () => new InsightStore(deps as never);
    const store = freshStore();
    await store.list({ organizationId: orgId }); // 首次访问 → 触发分批回填

    expect(await prisma.creativeHypothesis.count({ where: { id: { in: ids } } })).toBe(total - 1);
    expect(await prisma.creativeInsight.count({ where: { id: { in: ids } } })).toBe(1);
    // 跨批边界抽样（末行在第二批）：分批不丢行、原 id/归属/时间线保留
    expect((await store.get(ids[0]))?.doc).toMatchObject({ organizationId: orgId, status: 'draft', statement: '历史假设 0' });
    expect((await store.get(ids[BACKFILL_BATCH_SIZE - 1]))?.doc.statement).toBe(`历史假设 ${BACKFILL_BATCH_SIZE - 1}`);
    // 末行按 kind 分流进洞察专表 → 由 InsightStore 读取（假设 store 只认假设表）
    const last = await freshInsightStore().get(ids[total - 1]);
    expect(last?.doc.kind).toBe(INSIGHT_KIND);
    expect(last?.doc.organizationId).toBe(orgId);
    expect(last?.doc.factsHash).toBe('legacy-hash');
    expect(last?.createdAt).toEqual(new Date('2025-01-01T00:00:00Z'));

    // 幂等：再次回填（新 key）→ 既有专表行绝不被旧容器内容覆盖
    await prisma.creativeHypothesis.updateMany({ where: { id: ids[0] }, data: { statement: '专表内的最新陈述' } });
    await freshStore().list({ organizationId: orgId });
    expect((await store.get(ids[0]))?.doc.statement).toBe('专表内的最新陈述');
    // 只读迁移：旧容器行全部保留（审计痕迹）
    expect(await prisma.artifact.count({ where: { id: { in: ids } } })).toBe(total);
  });

  it('⑪ 来源判别（M12-P1 审计 R1）：agent 工具写入的绩效行不参与判定——伪造绩效绝不促成 validated', async () => {
    const feedback = app.get(FeedbackService, { strict: false });

    const h5 = await createHypothesis({
      statement: '来源判别假设：agent 自证绩效不算数',
      successCriteria: { metric: 'roas', op: 'gte', value: 50 },
    });
    await api().post(`/api/v1/creative-loop/hypotheses/${h5}/status`).set(XRW).set('Cookie', cookie)
      .send({ status: 'ready' }).expect(201);
    const started = await api().post(`/api/v1/creative-loop/hypotheses/${h5}/start`).set(XRW).set('Cookie', cookie)
      .send({ waitMs: 800 }).expect(201);
    const runId = started.body.data.run.runId as string;
    runIds.push(runId);
    const loopStartedAt = new Date((started.body.data.hypothesis.loop as { startedAt: string }).startedAt);

    // loop 运行中，走**真实 agent 工具路径**伪造绩效：AgentRun → AgentRunStep → ToolCall（账本行）→
    // FeedbackService 写副作用。ToolCall.output 是既有 schema 下唯一的来源信号（零 schema 变更）：
    // 账本与副作用**同事务**落库。
    const agent = await prisma.agent.findFirstOrThrow({ select: { id: true } });
    const agentRun = await prisma.agentRun.create({
      data: { userId, agentId: agent.id, projectId, status: 'completed', completedAt: new Date() },
    });
    agentRunIds.push(agentRun.id);
    const step = await prisma.agentRunStep.create({
      data: { runId: agentRun.id, stepIndex: 0, type: 'tool_call', status: 'completed', completedAt: new Date() },
    });
    const toolCall = await prisma.toolCall.create({
      data: {
        runStepId: step.id, toolName: AGENT_PERFORMANCE_TOOL, idempotencyKey: `e2e-m9p5-forge-${randomUUID()}`,
        input: {}, status: 'completed', completedAt: new Date(),
      },
    });
    // 伪造绩效：roas 极高——若来源判别失效，Agent 就能用自己回传的绩效**自证**假设成立
    const forged = await feedback.capturePerformance(userId, {
      projectId, platform: 'mock',
      metrics: { impressions: 10, clicks: 1, spend: 100, conversions: 1, revenue: 1_000_000, orders: 1 },
    }, { toolCallId: toolCall.id });
    const ledger = await prisma.toolCall.findUniqueOrThrow({ where: { id: toolCall.id } });
    expect(ledger.output).toMatchObject({ performanceId: forged.performanceId }); // 账本 = 副作用行 id（判别依据）
    // 伪造行**确实落在判定窗口内**（capturedAt >= loop.startedAt）——排除是判别在起作用，绝非窗口没覆盖
    const forgedRow = await prisma.creativePerformance.findUniqueOrThrow({ where: { id: forged.performanceId } });
    expect(forgedRow.capturedAt.getTime()).toBeGreaterThanOrEqual(loopStartedAt.getTime());

    const approval = (await waitFor(
      '来源判别 loop 审批',
      () => prisma.approval.findFirst({ where: { workflowRunId: runId, status: 'requested' } }),
      (a) => a !== null,
    ))!;
    await api().post(`/api/v1/approvals/${approval.id}/approve`).set(XRW).set('Cookie', cookie).expect(201);
    await waitFor(
      '来源判别 run 终态',
      () => prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } }),
      (r) => ['completed', 'failed', 'timeout'].includes(r.status),
    );

    // 窗口内只有 agent 伪造行 → 判别把该行整段排除 → 事实缺失 → **绝不自动判定**（伪造的自证不成立）
    const blocked = await api().get(`/api/v1/creative-loop/hypotheses/${h5}/status`).set('Cookie', cookie).expect(200);
    expect(blocked.body.data.hypothesis.status).toBe('running');
    expect(blocked.body.data.hypothesis.verdict).toBeNull();
    expect(blocked.body.data.pending.reason).toBe('awaiting-facts');

    // 外部（非 agent）事实回流 → 只用外部行求和判定：roas = 6000/100 = 60（伪造行的 1e6 收入绝不计入）
    await api().post('/api/v1/feedback/performance').set(XRW).set('Cookie', cookie)
      .send({
        projectId, platform: 'mock',
        metrics: { impressions: 1000, clicks: 60, spend: 100, conversions: 6, revenue: 6000, orders: 6 },
      }).expect(201);
    const converged = await api().get(`/api/v1/creative-loop/hypotheses/${h5}/status`).set('Cookie', cookie).expect(200);
    expect(converged.body.data.hypothesis.status).toBe('validated');
    expect(converged.body.data.hypothesis.verdict).toMatchObject({
      decision: 'validated',
      decidedBy: 'criteria',
      facts: {
        performance: {
          rows: 1, // 只有外部行参与求和
          excludedAgentRows: 1, // 被排除的 agent 行**留痕**（绝不静默丢弃）
          derived: { roas: 60, ctr: 0.06 },
          provenance: { rule: 'agent-tool-ledger-exclusion', complete: true },
        },
      },
    });
    // 判别是"判定豁免"，不是"数据删除"：伪造行本身仍在（审计痕迹完整）
    expect(await prisma.creativePerformance.count({ where: { id: forged.performanceId } })).toBe(1);
  });

  it('⑫ verdict 回流（M12-P1 学习桥）：既有判定作为新洞察/新假设的**只读**事实输入，绝不改写历史', async () => {
    // ① 新洞察：既有 verdict 作为事实层输入（服务端聚合 + 来源标注；解读层仍留空）
    const res = await api().post('/api/v1/creative-loop/insights').set(XRW).set('Cookie', cookie)
      .send({ projectId, days: 30, includeEvaluation: false }).expect(201);
    insightIds.push(res.body.data.id as string);
    const verdicts = (res.body.data.facts as Record<string, never>).verdicts as unknown as {
      entries: Array<Record<string, unknown>>; totals: Record<string, never>; source: string; rule: string;
    };
    expect(verdicts.source).toBe('historical-verdicts');
    expect(verdicts.rule).toBe('server-aggregate');
    const priorEntry = verdicts.entries.find((e) => e.hypothesisId === hypothesisId)!;
    expect(priorEntry).toMatchObject({
      statement, status: 'validated', projectId,
      decision: 'validated', decidedBy: 'criteria', rule: 'historical-verdict',
    });
    expect(priorEntry.criteria).toEqual({ metric: 'roas', op: 'gte', value: 1 });
    expect(verdicts.totals).toMatchObject({
      entries: verdicts.entries.length, // 无未判定行混入（只有终态且带 verdict 的行）
      validated: expect.any(Number), rejected: expect.any(Number),
      byDecider: { criteria: expect.any(Number), manual: 0, system: expect.any(Number) },
    });
    expect(verdicts.entries.map((e) => e.decidedBy)).toEqual(expect.arrayContaining(['criteria', 'system']));
    expect(res.body.data.interpretation).toBeNull();

    // ② 同 statement 新假设：历史判定作为**只读参考字段**返回（创建方可看到"上一轮学到什么"）
    const created = await api().post('/api/v1/creative-loop/hypotheses').set(XRW).set('Cookie', cookie)
      .send({ statement, projectId }).expect(201);
    const newId = created.body.data.id as string;
    hypothesisIds.push(newId);
    expect(created.body.data).toMatchObject({ status: 'draft', verdict: null, terminal: false });
    expect(created.body.data.priorVerdicts).toEqual([
      expect.objectContaining({
        hypothesisId, statement, status: 'validated',
        decision: 'validated', decidedBy: 'criteria', source: 'historical-verdict',
      }),
    ]);
    // 响应字段**绝不落库**：专表行仍是干净的 draft（无 verdict/历史，也无任何历史行痕迹）
    const newRow = await prisma.creativeHypothesis.findUniqueOrThrow({ where: { id: newId } });
    expect(newRow.status).toBe('draft');
    expect(newRow.verdict).toBeNull();
    expect(newRow.history).toEqual([]);
    expect(JSON.stringify(newRow)).not.toContain(hypothesisId);
    // 读路径不含该字段（先例只出现在 create 决策点）
    const read = await api().get(`/api/v1/creative-loop/hypotheses/${newId}`).set('Cookie', cookie).expect(200);
    expect(read.body.data.priorVerdicts).toBeUndefined();
    // ③ 历史行未被改写（只读引用 = 绝不重写历史）
    const oldRow = await prisma.creativeHypothesis.findUniqueOrThrow({ where: { id: hypothesisId } });
    expect(oldRow.status).toBe('validated');
    expect(oldRow.verdict).toMatchObject({ decision: 'validated', decidedBy: 'criteria' });
  });
});
