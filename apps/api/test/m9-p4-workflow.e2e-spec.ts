import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { z } from 'zod';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { ToolRegistry } from '../src/core/tools/tool-registry.service';
import { WORKFLOW_QUEUE } from '../src/core/queue/queue.module';
import { stepExternalActionKey, stepIdempotencyKey } from '../src/modules/workflows/workflow-executor.service';
import { bindPayload, hashPayload } from '../src/modules/approvals/approval-binding';
import { AppError, ErrorCode } from '../src/common/errors/app-error';
import type { Tool } from '../src/core/tools/tool.types';

/**
 * M9-P4 Advanced Workflow e2e（真实 PostgreSQL/Redis/BullMQ + Worker 进程内实例）。
 *
 * 运行方式（**独立 Redis DB，与 m7-p6/m8-p5 的 db 0 隔离**）：
 *   cd apps/api && REDIS_URL=redis://localhost:6379/8 npx vitest run test/m9-p4-workflow.e2e-spec.ts
 *
 * 覆盖：① wait（时间窗：落库期限 → 延迟唤醒 → 到期前进；含等待期间改定义不影响在跑 run 的版本锁定）
 *      ② 补偿链（逆序、**恰好一次**、幂等键锚点、崩溃重放不重复执行副作用、失败 run 记录补偿结果）
 *      ③ 审批表单（reason 模板 + 展示字段）+ 绑定摘要（自洽但绑定到**另一个动作**的审批 → 拒绝执行）
 *      ④ 步骤级超时（PROVIDER_TIMEOUT + 在途调用被 abort）与步骤级重试（瞬态 → attempt+1 → 成功）
 *
 * 说明：探针工具注册到 **Worker 侧** ToolRegistry（工作流步骤在 Worker 执行）；写副作用一律走既有
 * 外部动作/工具体系（探针工具为 permission='read'，绝不新增绕过路径）。
 */

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

async function waitForRunStatus(prisma: PrismaService, runId: string, targets: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'missing';
  while (Date.now() < deadline) {
    const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
    last = run?.status ?? 'missing';
    if (run && targets.includes(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`workflowRun ${runId} 未在 ${timeoutMs}ms 内到达 ${targets.join('/')}（当前 ${last}）`);
}

async function waitForStepStatus(
  prisma: PrismaService, runId: string, stepIndex: number, targets: string[], timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'missing';
  while (Date.now() < deadline) {
    const row = await prisma.workflowStepRun.findUnique({
      where: { workflowRunId_stepIndex: { workflowRunId: runId, stepIndex } },
    });
    last = row?.status ?? 'missing';
    if (row && targets.includes(row.status)) return row.status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`step ${stepIndex} of ${runId} 未在 ${timeoutMs}ms 内到达 ${targets.join('/')}（当前 ${last}）`);
}

async function waitForApproval(prisma: PrismaService, workflowRunId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const approval = await prisma.approval.findFirst({ where: { workflowRunId, status: 'requested' } });
    if (approval) return approval;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`workflowRun ${workflowRunId} 未在 ${timeoutMs}ms 内出现审批`);
}

// ---- 探针工具（记录调用事实，便于断言"恰好一次/幂等键/attempt"） ----
interface ProbeCall { tag: string; key: string }
const probeCalls: ProbeCall[] = [];
const sleepOutcomes: Array<{ ms: number; aborted: boolean; elapsedMs: number }> = [];
const flakyCounts = new Map<string, number>();

const argsSchema = z.record(z.string(), z.unknown());

const probeTools: Tool[] = [
  {
    name: 'probe.record',
    description: 'e2e 探针：记录调用（含幂等键）',
    inputSchema: argsSchema,
    permission: 'read',
    execute: async (input, ctx) => {
      const args = (input ?? {}) as Record<string, unknown>;
      probeCalls.push({ tag: String(args.tag ?? ''), key: ctx.idempotencyKey });
      return { ok: true, tag: args.tag ?? null, key: ctx.idempotencyKey };
    },
  },
  {
    name: 'probe.boom',
    description: 'e2e 探针：非瞬态失败（fail=yes 时）',
    inputSchema: argsSchema,
    permission: 'read',
    execute: async (input) => {
      const args = (input ?? {}) as Record<string, unknown>;
      if (String(args.fail ?? 'yes') === 'yes') {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'boom（非瞬态失败）');
      }
      return { ok: true, failed: false };
    },
  },
  {
    name: 'probe.sleep',
    description: 'e2e 探针：长耗时（受步骤 deadline 中止）',
    inputSchema: argsSchema,
    permission: 'read',
    execute: async (input, ctx) => {
      const ms = Number(((input ?? {}) as Record<string, unknown>).ms ?? 5_000);
      const startedAt = Date.now();
      return new Promise((resolve) => {
        const finish = (aborted: boolean) => {
          sleepOutcomes.push({ ms, aborted, elapsedMs: Date.now() - startedAt });
          resolve({ slept: aborted ? null : ms, aborted });
        };
        const timer = setTimeout(() => finish(false), ms);
        const onAbort = () => { clearTimeout(timer); finish(true); };
        if (ctx.signal.aborted) return onAbort();
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  },
  {
    name: 'probe.flaky',
    description: 'e2e 探针：首次瞬态失败（PROVIDER_TIMEOUT），其后成功',
    inputSchema: argsSchema,
    permission: 'read',
    execute: async (_input, ctx) => {
      const n = (flakyCounts.get(ctx.idempotencyKey) ?? 0) + 1;
      flakyCounts.set(ctx.idempotencyKey, n);
      if (n === 1) throw new AppError(ErrorCode.PROVIDER_TIMEOUT, 'flaky 首次瞬态失败');
      return { ok: true, attempt: n };
    },
  },
];

// ---- 工作流定义（M9-P4 增量能力） ----
const WAIT_DEF = {
  triggers: [{ type: 'manual' }],
  steps: [
    { id: 'mark', type: 'tool', tool: { name: 'probe.record', arguments: { tag: 'before-wait' } } },
    { id: 'hold', type: 'wait', wait: { untilMs: 3_000 } }, // 时间窗（相对时长）：首次进入换算绝对期限并落库
    { id: 'done', type: 'output', output: { finished: true, tag: '{{steps.mark.output.tag}}' } },
  ],
};

const COMP_DEF = {
  triggers: [{ type: 'manual' }],
  steps: [
    { id: 'charge', type: 'tool', tool: { name: 'probe.record', arguments: { tag: 'charge' } }, compensate: 'refund' },
    { id: 'risky', type: 'tool', tool: { name: 'probe.boom', arguments: { fail: '{{input.fail}}' } } },
    { id: 'refund', type: 'tool', tool: { name: 'probe.record', arguments: { tag: 'refund' } } }, // 补偿专用（正常流程跳过）
    { id: 'finish', type: 'output', output: { ok: true } },
  ],
};

const APPROVAL_DEF = {
  triggers: [{ type: 'manual' }],
  steps: [
    { id: 'prep', type: 'tool', tool: { name: 'probe.record', arguments: { tag: 'prep' } } },
    {
      id: 'sign', type: 'approval',
      approval: {
        reason: '发布 {{input.title}}（{{steps.prep.output.tag}}）', riskLevel: 'high',
        formFields: ['input.title', 'steps.prep.output.tag', 'input.missing'],
      },
    },
    { id: 'ship', type: 'external_action', externalAction: { actionType: 'success', payload: { title: '{{input.title}}' } } },
  ],
};

const TIMEOUT_DEF = {
  triggers: [{ type: 'manual' }],
  steps: [
    { id: 'slow', type: 'tool', tool: { name: 'probe.sleep', arguments: { ms: 5_000 } }, timeoutMs: 400 },
  ],
};

const RETRY_DEF = {
  triggers: [{ type: 'manual' }],
  steps: [
    {
      id: 'flaky', type: 'tool', tool: { name: 'probe.flaky', arguments: {} },
      retryPolicy: { maxRetries: 2, retryableCodes: ['PROVIDER_TIMEOUT'] },
    },
  ],
};

/**
 * M10-P5 D4/M9-01：run 级定义快照。首步骤 wait 先把 run 停在 waiting（让出 lease），
 * 使"改定义"发生在**恢复执行之前**——恢复时会重新进入 execute() 并重新解析定义，
 * 因此断言"执行的是快照而非被改写的版本行"是确定性的（不依赖与 worker 抢时序）。
 */
const snapshotDef = (tag: string) => ({
  triggers: [{ type: 'manual' }],
  steps: [
    { id: 'hold', type: 'wait', wait: { untilMs: 2_000 } },
    { id: 'mark', type: 'tool', tool: { name: 'probe.record', arguments: { tag } } },
    { id: 'done', type: 'output', output: { tag: '{{steps.mark.output.tag}}' } },
  ],
});
const SNAPSHOT_DEF = snapshotDef('snapshot-v1');

describe('M9-P4 Advanced Workflow (e2e, 真实 Queue + Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let userId = '';
  const workflowIds: string[] = [];
  const runIds: string[] = [];

  let waitWorkflowId = '';
  let waitVersionId = '';
  let compWorkflowId = '';
  let approvalWorkflowId = '';
  let timeoutWorkflowId = '';
  let retryWorkflowId = '';
  let snapshotWorkflowId = '';
  let snapshotVersionId = '';

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

    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
    // 探针工具注册到 Worker 侧注册表（工作流步骤由 Worker 内的 executor 执行）
    const registry = worker.get(ToolRegistry);
    for (const tool of probeTools) registry.register(tool);

    const createWorkflow = async (name: string, definition: unknown): Promise<string> => {
      const created = await request(app.getHttpServer()).post('/api/v1/workflows').set(XRW).set('Cookie', cookie)
        .send({ name, definition }).expect(201);
      const id = created.body.data.id as string;
      workflowIds.push(id);
      await request(app.getHttpServer()).post(`/api/v1/workflows/${id}/publish`).set(XRW).set('Cookie', cookie).expect(201);
      return id;
    };

    waitWorkflowId = await createWorkflow('e2e M9-P4 wait', WAIT_DEF);
    waitVersionId = (await prisma.workflowVersion.findFirst({ where: { workflowId: waitWorkflowId, status: 'published' } }))!.id;
    compWorkflowId = await createWorkflow('e2e M9-P4 compensation', COMP_DEF);
    approvalWorkflowId = await createWorkflow('e2e M9-P4 approval', APPROVAL_DEF);
    timeoutWorkflowId = await createWorkflow('e2e M9-P4 timeout', TIMEOUT_DEF);
    retryWorkflowId = await createWorkflow('e2e M9-P4 retry', RETRY_DEF);
    snapshotWorkflowId = await createWorkflow('e2e M9-P4/P5 snapshot', SNAPSHOT_DEF);
    snapshotVersionId = (await prisma.workflowVersion.findFirst({ where: { workflowId: snapshotWorkflowId, status: 'published' } }))!.id;
  });

  afterAll(async () => {
    if (worker) {
      const registry = worker.get(ToolRegistry);
      for (const tool of probeTools) registry.unregister(tool.name);
    }
    // 审批先删（workflowRunId SetNull 不留孤儿）；外部动作按 run 幂等键清理
    for (const runId of runIds) {
      await prisma.approval.deleteMany({ where: { workflowRunId: runId } }).catch(() => undefined);
    }
    await prisma.externalAction.deleteMany({
      where: {
        userId,
        idempotencyKey: { in: runIds.flatMap((r) => [0, 1, 2, 3, 4].map((i) => stepExternalActionKey(r, i))) },
      },
    }).catch(() => undefined);
    for (const id of workflowIds) {
      await prisma.workflow.delete({ where: { id } }).catch(() => undefined); // 级联 versions/runs/steps
    }
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  async function createRun(workflowId: string, payload: Record<string, unknown> = {}): Promise<string> {
    const res = await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/runs`).set(XRW).set('Cookie', cookie)
      .send({ payload }).expect(201);
    const runId = res.body.data.id as string;
    runIds.push(runId);
    return runId;
  }

  it('① wait 时间窗：期限落库 → 延迟唤醒（不早退）→ 到期前进 → run 完成；等待期间改定义不影响在跑 run', async () => {
    const runId = await createRun(waitWorkflowId, {});
    // 等待步骤进入 waiting（run 释放 lease，等外部唤醒）
    await waitForStepStatus(prisma, runId, 1, ['waiting']);
    const waitingRun = await prisma.workflowRun.findUnique({ where: { id: runId } });
    expect(waitingRun?.status).toBe('waiting');
    expect(waitingRun?.waitingOnApprovalId).toBeNull();
    expect(waitingRun?.waitingOnAgentRunId).toBeNull();
    expect(waitingRun?.workerId).toBeNull(); // 等待即让出 lease（绝不自旋占用）

    const holdRow = await prisma.workflowStepRun.findUnique({
      where: { workflowRunId_stepIndex: { workflowRunId: runId, stepIndex: 1 } },
    });
    const holdOutput = holdRow?.output as { kind?: string; waitingUntil?: string };
    expect(holdOutput?.kind).toBe('time');
    const untilMs = Date.parse(holdOutput!.waitingUntil!);
    expect(Number.isFinite(untilMs)).toBe(true);

    // 版本锁定（M9-P4 ⑤）：等待期间编辑定义 → 新 draft 版本；在跑 run 仍锁 v1（绝不半路换定义）
    const patched = await request(app.getHttpServer()).patch(`/api/v1/workflows/${waitWorkflowId}`).set(XRW).set('Cookie', cookie)
      .send({ definition: { ...WAIT_DEF, steps: [...WAIT_DEF.steps, { id: 'v2only', type: 'output', output: { v2: true } }] } })
      .expect(200);
    expect((patched.body.data.versions as Array<{ version: number; status: string }>)[0]).toMatchObject({ version: 2, status: 'draft' });
    expect((await prisma.workflowRun.findUnique({ where: { id: runId } }))?.versionId).toBe(waitVersionId);

    // 到期 → 延迟作业唤醒（主路径；本用例**从不调用 recoverStale**）→ 前进 → 完成
    expect(await waitForRunStatus(prisma, runId, ['completed', 'failed', 'timeout'], 20_000)).toBe('completed');
    const run = await prisma.workflowRun.findUnique({
      where: { id: runId }, include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    expect(run!.versionId).toBe(waitVersionId);
    expect(run!.output).toMatchObject({ finished: true, tag: 'before-wait' }); // 步骤输出参与后续模板渲染
    // 绝不提前前进：终态时间 >= 落库期限
    expect(run!.completedAt!.getTime()).toBeGreaterThanOrEqual(untilMs);
    // 版本锁定：v2 新增步骤绝不出现在本次 run 的步骤行里
    expect(run!.steps.map((s) => s.stepId)).toEqual(['mark', 'hold', 'done']);

    const holdDone = run!.steps[1];
    expect(holdDone.status).toBe('completed');
    expect(holdDone.stepType).toBe('wait');
    expect(holdDone.output).toMatchObject({ kind: 'time' });
    expect((holdDone.output as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(2_500);
  });

  it('② 补偿链：A 成功 → B 非瞬态失败 → A 的补偿**恰好执行一次**（幂等键锚点）→ run failed + 补偿记录；崩溃重放绝不重复执行', async () => {
    const before = probeCalls.length;
    const runId = await createRun(compWorkflowId, { fail: 'yes' });
    expect(await waitForRunStatus(prisma, runId, ['failed', 'completed', 'timeout'], 30_000)).toBe('failed');

    const run = await prisma.workflowRun.findUnique({
      where: { id: runId }, include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    expect(run?.errorCode).toBe('VALIDATION_ERROR');
    const byIndex = new Map(run!.steps.map((s) => [s.stepIndex, s]));
    expect(byIndex.get(0)!.status).toBe('completed'); // charge 成功（需补偿）
    expect(byIndex.get(1)!.status).toBe('failed');    // risky 非瞬态失败
    expect(byIndex.get(2)!.status).toBe('completed'); // refund = 补偿执行（锚点行 stepType='compensation'）
    expect(byIndex.get(2)!.stepType).toBe('compensation');
    expect(run!.steps.some((s) => s.stepId === 'finish')).toBe(false); // 失败后绝不继续后续步骤

    // 补偿记录进 run.output（终态输出）
    expect(run!.output).toMatchObject({
      compensation: [{ stepId: 'charge', compensateStepId: 'refund', stepIndex: 2, status: 'completed' }],
    });

    // **恰好一次** + 副作用幂等键 = 锚点 (runId, stepIndex)
    const calls = probeCalls.slice(before);
    expect(calls.map((c) => c.tag)).toEqual(['charge', 'refund']);
    expect(calls[0].key).toBe(stepIdempotencyKey(runId, 0));
    expect(calls[1].key).toBe(stepIdempotencyKey(runId, 2)); // 补偿复用补偿步骤自身的锚点键
    expect(await prisma.workflowStepRun.count({ where: { workflowRunId: runId, stepIndex: 2 } })).toBe(1); // 锚点行唯一

    // 崩溃重放（模拟"补偿已执行但终态写入前崩溃"）：run 回到 queued → 真实 worker 重新 claim
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: 'queued', workerId: null, leaseUntil: null, heartbeatAt: null, completedAt: null, errorCode: null, errorMessage: null },
    });
    const queue = app.get<Queue>(getQueueToken(WORKFLOW_QUEUE));
    await queue.add('execute', { runId }, {
      jobId: `m9p4-replay-${runId}`, attempts: 1, removeOnComplete: true, removeOnFail: { count: 500 },
    });
    expect(await waitForRunStatus(prisma, runId, ['failed'], 30_000)).toBe('failed');
    const replayed = await prisma.workflowRun.findUnique({
      where: { id: runId }, include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    // 幂等：补偿锚点行已 completed → **绝不重复执行副作用**（探针调用数不变）
    expect(probeCalls.slice(before).map((c) => c.tag)).toEqual(['charge', 'refund']);
    expect(replayed!.output).toMatchObject({
      compensation: [{ stepId: 'charge', compensateStepId: 'refund', stepIndex: 2, status: 'completed' }],
    });
    expect(await prisma.workflowStepRun.count({ where: { workflowRunId: runId, stepIndex: 2 } })).toBe(1);
  });

  it('②b 无失败路径：补偿专用步骤在正常流程中**绝不执行**（skipped + 前进）', async () => {
    const before = probeCalls.length;
    const runId = await createRun(compWorkflowId, { fail: 'no' });
    expect(await waitForRunStatus(prisma, runId, ['completed', 'failed', 'timeout'], 30_000)).toBe('completed');
    const run = await prisma.workflowRun.findUnique({
      where: { id: runId }, include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    const refundRow = run!.steps.find((s) => s.stepId === 'refund');
    expect(refundRow?.status).toBe('skipped');
    expect(refundRow?.output).toMatchObject({ skipped: true, reason: 'compensation-only step' });
    expect(run!.output).toMatchObject({ ok: true });
    expect(probeCalls.slice(before).map((c) => c.tag)).toEqual(['charge']); // refund 绝不被调用
  });

  it('③ 审批表单 + 绑定：reason 模板/展示字段解析，摘要只绑定**将被执行的动作**（表单不参与摘要）；绑定漂移 → 拒绝执行', async () => {
    // ③-1 正常路径：表单 + 绑定一致 → 审批 → 外部动作执行（载荷 = 绑定的动作）
    const runId = await createRun(approvalWorkflowId, { title: '主图 v2' });
    const approval = await waitForApproval(prisma, runId);
    expect(approval.riskLevel).toBe('high');
    expect(approval.reason).toBe('发布 主图 v2（prep）'); // reason 模板渲染（{{input.x}} + {{steps.<id>.output.y}}）
    const payload = approval.payload as {
      stepId: string; boundActionType: string; boundAction: unknown;
      form: Record<string, unknown>; __binding: { actionType: string; payloadHash: string };
    };
    expect(payload.form).toEqual({ 'input.title': '主图 v2', 'steps.prep.output.tag': 'prep', 'input.missing': null });
    expect(payload.boundActionType).toBe('success'); // 绑定口径 = 下游 external_action 步骤
    expect(payload.boundAction).toEqual({ title: '主图 v2' });
    expect(payload.__binding.actionType).toBe('success');
    // 展示字段绝不参与摘要（摘要 = 稳定序列化后的动作载荷）
    expect(payload.__binding.payloadHash).toBe(hashPayload(payload.boundAction));

    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/approve`).set(XRW).set('Cookie', cookie).expect(201);
    expect(await waitForRunStatus(prisma, runId, ['completed', 'failed', 'timeout'], 30_000)).toBe('completed');
    const action = await prisma.externalAction.findUnique({
      where: { userId_provider_idempotencyKey: { userId, provider: 'mock', idempotencyKey: stepExternalActionKey(runId, 2) } },
    });
    expect(action?.status).toBe('completed');
    expect(action?.approvalId).toBe(approval.id);
    expect((action?.input as { title?: string } | null)?.title).toBe('主图 v2'); // 执行 = 被绑定的动作本身

    // ③-2 绑定漂移：审批被替换为**自洽但绑定另一个动作**的载荷 → 执行前重算摘要 → 拒绝执行
    const tamperedRunId = await createRun(approvalWorkflowId, { title: '主图 v2' });
    const tampered = await waitForApproval(prisma, tamperedRunId);
    const otherAction = { title: '攻击者替换的标题' };
    await prisma.approval.update({
      where: { id: tampered.id },
      data: {
        payload: bindPayload( // 攻击者把它改成一个"格式完全合法"的绑定（摘要与动作自洽）
          { stepId: 'sign', boundActionType: 'success', boundAction: otherAction },
          'success', otherAction,
        ) as never,
      },
    });
    await request(app.getHttpServer()).post(`/api/v1/approvals/${tampered.id}/approve`).set(XRW).set('Cookie', cookie).expect(201);
    expect(await waitForRunStatus(prisma, tamperedRunId, ['failed', 'completed', 'timeout'], 30_000)).toBe('failed');
    const failedRun = await prisma.workflowRun.findUnique({ where: { id: tamperedRunId } });
    expect(failedRun?.errorCode).toBe('APPROVAL_BINDING_MISMATCH'); // 审批必须绑定"此刻将被执行的具体动作"
    // 被替换的动作绝不被执行：无外部动作行
    expect(await prisma.externalAction.count({ where: { userId, idempotencyKey: stepExternalActionKey(tamperedRunId, 2) } })).toBe(0);
  });

  it('④ 步骤级超时：timeoutMs 到点 → 在途调用被 abort + 步骤/run 归因 PROVIDER_TIMEOUT（不等 5s 睡眠）', async () => {
    const before = sleepOutcomes.length;
    const startedAt = Date.now();
    const runId = await createRun(timeoutWorkflowId, {});
    expect(await waitForRunStatus(prisma, runId, ['failed', 'completed', 'timeout'], 20_000)).toBe('failed');
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(3_000); // 远小于探针的 5s 睡眠：deadline 竞速 + abort 生效

    const run = await prisma.workflowRun.findUnique({
      where: { id: runId }, include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    expect(run?.errorCode).toBe('PROVIDER_TIMEOUT'); // 超时归因瞬态码（可被 retryPolicy 接住）
    expect(run!.steps[0].status).toBe('failed');
    expect(run!.steps[0].errorCode).toBe('PROVIDER_TIMEOUT');
    expect(run!.steps[0].errorMessage).toContain('步骤执行超时');
    // 在途工具调用确实收到了 abort（signal 下传，非仅"竞速放弃"）
    const outcome = sleepOutcomes.slice(before)[0];
    expect(outcome?.aborted).toBe(true);
    expect(outcome?.elapsedMs).toBeLessThan(3_000);
  });

  it('④b 步骤级重试：瞬态失败 → 同一锚点重试（attempt+1）→ 成功；retryPolicy 覆盖既有 maxAttempts 语义', async () => {
    const runId = await createRun(retryWorkflowId, {});
    expect(await waitForRunStatus(prisma, runId, ['completed', 'failed', 'timeout'], 30_000)).toBe('completed');
    const run = await prisma.workflowRun.findUnique({
      where: { id: runId }, include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    const flakyRow = run!.steps[0];
    expect(flakyRow.status).toBe('completed');
    expect(flakyRow.attempt).toBe(2); // 首次瞬态失败 → 重试一次后成功
    expect(flakyRow.output).toMatchObject({ ok: true, attempt: 2 });
    expect(flakyCounts.get(stepIdempotencyKey(runId, 0))).toBe(2); // 重试复用同一锚点幂等键
  });

  it('⑤ 定义快照（M10-P5 D4）：run 创建即写快照；版本行被改写后**仍按快照执行**；快照缺失（历史 run）回退版本行', async () => {
    // ① 快照优先：run 停在 waiting 期间改写**版本行**（模拟迁移/修复/历史行被改写——不再依赖"published 行不可变"这一外部约定）
    const runId = await createRun(snapshotWorkflowId, {});
    await waitForStepStatus(prisma, runId, 0, ['waiting']);
    const created = await prisma.workflowRun.findUnique({ where: { id: runId } });
    expect((created?.definitionSnapshot as { steps: Array<{ id: string }> }).steps.map((s) => s.id))
      .toEqual(['hold', 'mark', 'done']); // 创建时即落快照（与 versionId 同刻锁定）
    expect((created?.definitionSnapshot as { steps: Array<{ tool?: { arguments?: { tag?: string } } }> }).steps[1].tool?.arguments?.tag)
      .toBe('snapshot-v1');

    await prisma.workflowVersion.update({
      where: { id: snapshotVersionId },
      data: { definition: snapshotDef('tampered-version-row') as never },
    });
    // 版本行确实已被改写（否则本用例无鉴别力）
    const tamperedVersion = await prisma.workflowVersion.findUnique({ where: { id: snapshotVersionId } });
    expect((tamperedVersion!.definition as { steps: Array<{ tool?: { arguments?: { tag?: string } } }> }).steps[1].tool?.arguments?.tag)
      .toBe('tampered-version-row');

    expect(await waitForRunStatus(prisma, runId, ['completed', 'failed', 'timeout'], 20_000)).toBe('completed');
    const run = await prisma.workflowRun.findUnique({
      where: { id: runId }, include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    // 恢复执行时重新解析定义 → 取的是 run 自己的快照，**绝不读被改写的版本行**
    expect(run!.steps.find((s) => s.stepId === 'mark')!.output).toMatchObject({ tag: 'snapshot-v1' });
    expect(run!.output).toMatchObject({ tag: 'snapshot-v1' });
    expect(run!.errorCode).toBeNull();

    // ② 历史 run 回退：快照列上线前的行为（definitionSnapshot = null）→ 回退锁定版本行（= 已改写的那份）
    const legacyRunId = await createRun(snapshotWorkflowId, {});
    await waitForStepStatus(prisma, legacyRunId, 0, ['waiting']);
    await prisma.workflowRun.update({ where: { id: legacyRunId }, data: { definitionSnapshot: null as never } });
    expect(await waitForRunStatus(prisma, legacyRunId, ['completed', 'failed', 'timeout'], 20_000)).toBe('completed');
    const legacyRun = await prisma.workflowRun.findUnique({
      where: { id: legacyRunId }, include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    expect(legacyRun!.definitionSnapshot).toBeNull();
    expect(legacyRun!.steps.find((s) => s.stepId === 'mark')!.output).toMatchObject({ tag: 'tampered-version-row' });
  });
});
