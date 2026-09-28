import { describe, it, expect, vi } from 'vitest';
import { CreativeLoopOrchestrator } from './loop-orchestrator.service';
import { HypothesisDoc, StoredDoc } from './creative-loop-store';
import { isTerminal } from './hypothesis-status';
import { buildLoopDefinition } from './loop-template';
import { AppError, ErrorCode } from '../../common/errors/app-error';

const NOW = new Date('2026-01-01T00:00:00Z');

function makeDoc(over: Partial<HypothesisDoc> = {}): HypothesisDoc {
  return {
    kind: 'creative_hypothesis',
    organizationId: 'org1',
    projectId: 'proj1',
    status: 'ready',
    statement: '高对比主图可提升点击率',
    rationale: null,
    target: null,
    platform: null,
    insightId: null,
    successCriteria: null,
    loop: null,
    evaluationRunId: null,
    baselineRunId: null,
    experimentId: null,
    verdict: null,
    history: [],
    ...over,
  };
}

interface RunFixture {
  id: string;
  workflowId: string;
  versionId: string;
  status: string;
  attempt: number;
  currentStep: number;
  waitingOnApprovalId: string | null;
  errorCode: string | null;
  startedAt: Date;
  completedAt: Date | null;
  output: unknown;
  version: { version: number };
  steps: Array<Record<string, unknown>>;
}

function makeRun(over: Partial<RunFixture> = {}): RunFixture {
  return {
    id: 'run-1',
    workflowId: 'wf-1',
    versionId: 'ver-1',
    status: 'queued',
    attempt: 1,
    currentStep: 0,
    waitingOnApprovalId: null,
    errorCode: null,
    startedAt: NOW,
    completedAt: null,
    output: null,
    version: { version: 1 },
    steps: [],
    ...over,
  };
}

function makeHarness(over: {
  doc?: HypothesisDoc | null;
  run?: RunFixture | null;
  perfRows?: Array<Record<string, number>>;
  existingWorkflow?: { id: string; versions: Array<{ version: number; status: string; definition: unknown }> } | null;
  /** 并发创建收敛用例：创建后"最早一行"再查询的结果（缺省 = 自己刚创建的行，即无并发对手） */
  winnerWorkflow?: { id: string } | null;
  casCount?: number;
  evaluationDetail?: unknown;
  evaluationScope?: { id: string; organizationId: string } | null;
  experimentScope?: { id: string; organizationId: string } | null;
  transitionError?: Error;
} = {}) {
  let current: StoredDoc<HypothesisDoc> | null = over.doc === null ? null : {
    id: 'hyp-1',
    userId: 'u1',
    doc: over.doc ?? makeDoc(),
    createdAt: NOW,
    updatedAt: NOW,
  };
  const store = {
    get: vi.fn(async () => current),
    cas: vi.fn(async (_id: string, from: readonly string[], next: HypothesisDoc) => {
      if (!current || !from.includes(current.doc.status)) return 0;
      if (over.casCount === 0) return 0;
      current = { ...current, doc: next };
      return 1;
    }),
  };
  const hypotheses = {
    requireWritable: vi.fn(async () => {
      if (!current) throw Object.assign(new Error('假设不存在'), { code: 'NOT_FOUND' });
      return current;
    }),
    requireReadable: vi.fn(async () => {
      if (!current) throw Object.assign(new Error('假设不存在'), { code: 'NOT_FOUND' });
      return current;
    }),
    transition: vi.fn(async (_u: string, _id: string, to: HypothesisDoc['status'], opts: { by: string; patch?: Partial<HypothesisDoc> }) => {
      if (over.transitionError) throw over.transitionError;
      const next: HypothesisDoc = {
        ...current!.doc,
        ...(opts.patch ?? {}),
        status: to,
        history: [...current!.doc.history, { from: current!.doc.status, to, at: NOW.toISOString(), by: opts.by }],
      };
      current = { ...current!, doc: next };
      return thisToView(current);
    }),
    patch: vi.fn(async (_id: string, patch: Partial<HypothesisDoc>) => {
      const next = { ...current!.doc, ...patch };
      current = { ...current!, doc: next };
      return current;
    }),
    toView: (s: StoredDoc<HypothesisDoc>) => thisToView(s),
  };
  let workflowFindCalls = 0;
  const prisma = {
    workflow: {
      // 首次 = 启动前的既有行查询；其后 = 创建后重新选取"最早一行"（并发收敛）
      findFirst: vi.fn(async () => {
        workflowFindCalls += 1;
        if (over.winnerWorkflow !== undefined && workflowFindCalls >= 2) return over.winnerWorkflow;
        return over.existingWorkflow ?? null;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
    },
    project: { findFirst: vi.fn(async () => null) },
    workflowRun: { findUnique: vi.fn(async () => (over.run === undefined ? makeRun() : over.run)) },
    creativePerformance: { findMany: vi.fn(async () => over.perfRows ?? []) },
  };
  const workflows = {
    create: vi.fn(async (_u: string, input: { name: string }) => ({ id: 'wf-1', name: input.name })),
    publish: vi.fn(async () => ({ id: 'wf-1' })),
    update: vi.fn(async () => ({ id: 'wf-1' })),
  };
  const runs = { createRun: vi.fn(async () => ({ id: 'run-1', status: 'queued' })) };
  const insights = { get: vi.fn(async () => null) };
  const evaluationRuns = {
    scope: vi.fn(async () => (over.evaluationScope === undefined ? { id: 'eval-1', organizationId: 'org1' } : over.evaluationScope)),
    get: vi.fn(async () => (over.evaluationDetail ?? {
      run: { id: 'eval-1', status: 'completed', baselineRunId: 'eval-0' },
      scores: { overall: { evaluated: 4, passed: 3, failed: 1, avgScore: 0.9, passRate: 0.75 }, evaluators: [], caseRuns: {} },
    })),
  };
  const experiments = {
    scope: vi.fn(async () => (over.experimentScope === undefined ? { id: 'exp-1', organizationId: 'org1' } : over.experimentScope)),
  };
  const service = new CreativeLoopOrchestrator(
    prisma as never, store as never, insights as never, hypotheses as never,
    workflows as never, runs as never, evaluationRuns as never, experiments as never,
  );
  return { service, store, hypotheses, prisma, workflows, runs, evaluationRuns, experiments, getCurrent: () => current };
}

function thisToView(s: StoredDoc<HypothesisDoc>) {
  return { ...s.doc, id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, terminal: isTerminal(s.doc.status) };
}

/**
 * Loop 编排单测：定义固化（版本锁定）、run 幂等、状态推进条件更新、run 终态收敛语义。
 * 断言重点 = "绝不在半路换定义 / 绝不盲目覆盖状态 / 事实不足绝不臆断判定"。
 */
describe('CreativeLoopOrchestrator（loop 启动 + 收敛）', () => {
  it('start：ready → 固化并发布 workflow → 创建幂等 run → 状态推进 running（带 loop 引用）', async () => {
    const h = makeHarness({ doc: makeDoc({ status: 'ready' }) });
    const result = await h.service.start('u1', 'hyp-1', { waitMs: 2000 });
    expect(h.workflows.create).toHaveBeenCalledTimes(1);
    const createArg = h.workflows.create.mock.calls[0][1] as unknown as { name: string; definition: unknown };
    expect(createArg.name).toBe('creative-loop:hyp-1');
    expect(createArg.definition).toEqual(buildLoopDefinition({ hypothesisId: 'hyp-1', statement: '高对比主图可提升点击率', waitMs: 2000 }));
    expect(h.workflows.publish).toHaveBeenCalledWith('u1', 'wf-1');
    expect(h.runs.createRun).toHaveBeenCalledWith('u1', expect.objectContaining({
      workflowId: 'wf-1',
      triggerType: 'manual',
      idempotencyKey: 'creative-loop:hyp-1:1',
      attempt: 1,
      payload: expect.objectContaining({ hypothesisId: 'hyp-1', statement: '高对比主图可提升点击率' }),
    }));
    expect(h.hypotheses.transition).toHaveBeenCalledWith('u1', 'hyp-1', 'running', expect.objectContaining({
      by: 'manual',
      patch: { loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: expect.any(String) } },
    }));
    expect(result.hypothesis.status).toBe('running');
    expect(result.run).toMatchObject({ runId: 'run-1', status: 'queued', version: 1 });
  });

  it('start：非 ready（draft/终态）→ 400 且绝不建 workflow/run（状态机是唯一入口）', async () => {
    for (const status of ['draft', 'validated', 'rejected'] as const) {
      const h = makeHarness({ doc: makeDoc({ status }) });
      await expect(h.service.start('u1', 'hyp-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(h.workflows.create).not.toHaveBeenCalled();
      expect(h.runs.createRun).not.toHaveBeenCalled();
    }
  });

  it('start：重跑复用同一 published 版本（定义逐字节一致 → 不新建/不重发）', async () => {
    const definition = buildLoopDefinition({ hypothesisId: 'hyp-1', statement: '高对比主图可提升点击率' });
    const h = makeHarness({
      doc: makeDoc({ status: 'ready', loop: { workflowId: 'wf-1', runId: 'run-old', attempts: 1, startedAt: NOW.toISOString() } }),
      existingWorkflow: { id: 'wf-1', versions: [{ version: 1, status: 'published', definition }] },
    });
    await h.service.start('u1', 'hyp-1');
    expect(h.workflows.create).not.toHaveBeenCalled();
    expect(h.workflows.publish).not.toHaveBeenCalled();
    expect(h.runs.createRun).toHaveBeenCalledWith('u1', expect.objectContaining({ idempotencyKey: 'creative-loop:hyp-1:2', attempt: 2 }));
  });

  it('start：参数与固化定义不一致 → 400（版本锁定：绝不在半路换定义）', async () => {
    const definition = buildLoopDefinition({ hypothesisId: 'hyp-1', statement: '高对比主图可提升点击率' });
    const h = makeHarness({
      doc: makeDoc({ status: 'ready' }),
      existingWorkflow: { id: 'wf-1', versions: [{ version: 1, status: 'published', definition }] },
    });
    await expect(h.service.start('u1', 'hyp-1', { waitMs: 9999 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.runs.createRun).not.toHaveBeenCalled();
  });

  it('start：已在运行（running + runId）→ 幂等读现状，绝不新建 workflow/run（双击的确定性结果）', async () => {
    const h = makeHarness({
      doc: makeDoc({
        status: 'running',
        loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW.toISOString() },
      }),
    });
    const result = await h.service.start('u1', 'hyp-1');
    expect(result.hypothesis.status).toBe('running');
    expect(result.run).toMatchObject({ runId: 'run-1' });
    expect(h.workflows.create).not.toHaveBeenCalled();
    expect(h.workflows.publish).not.toHaveBeenCalled();
    expect(h.runs.createRun).not.toHaveBeenCalled();
    expect(h.hypotheses.transition).not.toHaveBeenCalled();
  });

  it('start：并发创建 workflow（自己不是最早一行）→ 删除自己的重复行并回退到最早行（绝不各跑一个 run）', async () => {
    const h = makeHarness({
      doc: makeDoc({ status: 'ready' }),
      existingWorkflow: null, // 并发双方启动前都没查到既有行 → 各自创建
      winnerWorkflow: { id: 'wf-early' }, // 创建后重查：最早一行是并发对手创建的
    });
    const result = await h.service.start('u1', 'hyp-1');
    expect(h.workflows.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.workflow.delete).toHaveBeenCalledWith({ where: { id: 'wf-1' } }); // 只删自己刚建的行
    // run 建在**胜者**（最早行）上 → 幂等键相同 → 两个请求收敛到同一 run
    expect(h.runs.createRun).toHaveBeenCalledWith('u1', expect.objectContaining({
      workflowId: 'wf-early',
      idempotencyKey: 'creative-loop:hyp-1:1',
    }));
    expect(h.hypotheses.transition).toHaveBeenCalledWith('u1', 'hyp-1', 'running', expect.objectContaining({
      patch: { loop: expect.objectContaining({ workflowId: 'wf-early', runId: 'run-1' }) },
    }));
    expect(result.hypothesis.loop).toMatchObject({ workflowId: 'wf-early' });
  });

  it('start：并发双击（CAS 失败但 runId 已是本次 run）→ 返回现状，不报错、不产生第二个 run', async () => {
    const h = makeHarness({
      doc: makeDoc({ status: 'ready' }),
      transitionError: new AppError(ErrorCode.VALIDATION_ERROR, '假设状态已被并发修改，请刷新后重试'),
    });
    // 模拟赢家已落库：running + 同一 run
    const winner = makeDoc({
      status: 'running',
      loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW.toISOString() },
    });
    h.store.get.mockImplementation(async () => ({
      id: 'hyp-1', userId: 'u1', doc: winner, createdAt: NOW, updatedAt: NOW,
    }));
    const result = await h.service.start('u1', 'hyp-1');
    expect(h.runs.createRun).toHaveBeenCalledTimes(1);
    expect(result.hypothesis.status).toBe('running');
  });

  it('收敛：run 完成 + 判据可评估 → 按判据判定（criteria 归因），条件更新锚定 running', async () => {
    const doc = makeDoc({
      status: 'running',
      successCriteria: { metric: 'roas', op: 'gte', value: 2 },
      loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW.toISOString() },
    });
    const h = makeHarness({
      doc,
      run: makeRun({ status: 'completed', completedAt: NOW, output: { hypothesisId: 'hyp-1' } }),
      perfRows: [{ impressions: 1000, clicks: 50, spend: 100, conversions: 5, revenue: 300, orders: 5 }],
    });
    const result = await h.service.status('u1', 'hyp-1');
    expect(h.store.cas).toHaveBeenCalledWith('hyp-1', ['running'], expect.objectContaining({ status: 'validated' }));
    expect(result.hypothesis.status).toBe('validated');
    expect(result.hypothesis.verdict).toMatchObject({
      decision: 'validated', decidedBy: 'criteria', reason: expect.stringContaining('roas=3'),
      criteria: { metric: 'roas', op: 'gte', value: 2 },
      facts: expect.objectContaining({ performance: expect.objectContaining({ rows: 1, derived: expect.objectContaining({ roas: 3 }) }) }),
    });
    expect(result.pending.reason).toBeNull();
  });

  it('收敛：run 完成 + 判据未达标 → rejected（同一条件更新路径）', async () => {
    const doc = makeDoc({
      status: 'running',
      successCriteria: { metric: 'roas', op: 'gte', value: 5 },
      loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW.toISOString() },
    });
    const h = makeHarness({
      doc,
      run: makeRun({ status: 'completed' }),
      perfRows: [{ impressions: 1000, clicks: 50, spend: 100, conversions: 5, revenue: 300, orders: 5 }],
    });
    const result = await h.service.status('u1', 'hyp-1');
    expect(result.hypothesis.status).toBe('rejected');
    expect(result.hypothesis.verdict).toMatchObject({ decidedBy: 'criteria', decision: 'rejected' });
  });

  it('收敛：事实未回流 → 保持 running（绝不臆断判定），pending=awaiting-facts', async () => {
    const doc = makeDoc({
      status: 'running',
      successCriteria: { metric: 'roas', op: 'gte', value: 2 },
      loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW.toISOString() },
    });
    const h = makeHarness({ doc, run: makeRun({ status: 'completed' }), perfRows: [] });
    const result = await h.service.status('u1', 'hyp-1');
    expect(h.store.cas).not.toHaveBeenCalled();
    expect(result.hypothesis.status).toBe('running');
    expect(result.pending).toMatchObject({ reason: 'awaiting-facts' });
  });

  it('收敛：无判据 → 保持 running，pending=awaiting-criteria（判定交给人工/Agent）', async () => {
    const doc = makeDoc({
      status: 'running',
      loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW.toISOString() },
    });
    const h = makeHarness({ doc, run: makeRun({ status: 'completed' }) });
    const result = await h.service.status('u1', 'hyp-1');
    expect(h.store.cas).not.toHaveBeenCalled();
    expect(result.pending.reason).toBe('awaiting-criteria');
  });

  it('收敛：run failed → 系统归因驳回（decidedBy=system）；run cancelled → 保留 running 待人工判定', async () => {
    const base = {
      status: 'running' as const,
      loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW.toISOString() },
    };
    const failed = makeHarness({ doc: makeDoc(base), run: makeRun({ status: 'failed', errorCode: 'PROVIDER_TIMEOUT' }) });
    const failedResult = await failed.service.status('u1', 'hyp-1');
    expect(failedResult.hypothesis.status).toBe('rejected');
    expect(failedResult.hypothesis.verdict).toMatchObject({ decidedBy: 'system', reason: expect.stringContaining('failed') });

    const cancelled = makeHarness({ doc: makeDoc(base), run: makeRun({ status: 'cancelled' }) });
    const cancelledResult = await cancelled.service.status('u1', 'hyp-1');
    expect(cancelled.store.cas).not.toHaveBeenCalled();
    expect(cancelledResult.hypothesis.status).toBe('running');
    expect(cancelledResult.pending.reason).toBe('cancelled-needs-verdict');
  });

  it('收敛：并发读同时收敛（CAS 未命中）→ 不抛错，返回当前状态', async () => {
    const doc = makeDoc({
      status: 'running',
      loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW.toISOString() },
    });
    const h = makeHarness({ doc, run: makeRun({ status: 'failed' }), casCount: 0 });
    const result = await h.service.status('u1', 'hyp-1');
    expect(result.hypothesis.status).toBe('running');
  });

  it('收敛：等待审批中 → pending=awaiting-approval（返回 approvalId 供审批端点使用）', async () => {
    const doc = makeDoc({
      status: 'running',
      loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW.toISOString() },
    });
    const h = makeHarness({ doc, run: makeRun({ status: 'waiting', waitingOnApprovalId: 'appr-1' }) });
    const result = await h.service.status('u1', 'hyp-1');
    expect(result.run?.waitingOnApprovalId).toBe('appr-1');
    expect(result.pending).toMatchObject({ reason: 'awaiting-approval', detail: expect.stringContaining('appr-1') });
  });

  it('conclude：显式 decision → manual 归因；run 未终态时拒绝判定', async () => {
    const looping = makeDoc({
      status: 'running',
      loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW.toISOString() },
    });
    const busy = makeHarness({ doc: looping, run: makeRun({ status: 'running' }) });
    await expect(busy.service.conclude('u1', 'hyp-1', {} )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const done = makeHarness({ doc: looping, run: makeRun({ status: 'completed' }) });
    const result = await done.service.conclude('u1', 'hyp-1', { decision: 'rejected', reason: '创意不符合品牌规范' });
    expect(result.hypothesis.status).toBe('rejected');
    expect(result.hypothesis.verdict).toMatchObject({ decidedBy: 'manual', reason: '创意不符合品牌规范' });
    expect(done.hypotheses.transition).toHaveBeenCalledWith('u1', 'hyp-1', 'rejected', expect.objectContaining({ by: 'manual' }));
  });

  it('conclude：无 decision 时按判据判定；判据不可评估 → 400（绝不默认放行）', async () => {
    const doc = makeDoc({
      status: 'running',
      successCriteria: { metric: 'roas', op: 'gte', value: 2 },
      loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW.toISOString() },
    });
    const noFacts = makeHarness({ doc, run: makeRun({ status: 'completed' }), perfRows: [] });
    await expect(noFacts.service.conclude('u1', 'hyp-1', {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const withFacts = makeHarness({
      doc, run: makeRun({ status: 'completed' }),
      perfRows: [{ impressions: 100, clicks: 5, spend: 100, conversions: 1, revenue: 400, orders: 1 }],
    });
    const result = await withFacts.service.conclude('u1', 'hyp-1', {});
    expect(result.hypothesis.status).toBe('validated');
    expect(withFacts.hypotheses.transition).toHaveBeenCalledWith('u1', 'hyp-1', 'validated', expect.objectContaining({ by: 'criteria' }));
  });

  it('attachEvaluation/attachExperiment：仅引用既有 P1 资源（跨组织 → 404；同组织 → 条件更新挂接）', async () => {
    const doc = makeDoc({ status: 'running', loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW.toISOString() } });
    const crossOrg = makeHarness({ doc, evaluationScope: { id: 'eval-1', organizationId: 'org-other' } });
    await expect(crossOrg.service.attachEvaluation('u1', 'hyp-1', 'eval-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(crossOrg.hypotheses.patch).not.toHaveBeenCalled();

    const ok = makeHarness({ doc });
    await ok.service.attachEvaluation('u1', 'hyp-1', 'eval-1');
    expect(ok.hypotheses.patch).toHaveBeenCalledWith('hyp-1', { evaluationRunId: 'eval-1', baselineRunId: 'eval-0' });
    await ok.service.attachExperiment('u1', 'hyp-1', 'exp-1');
    expect(ok.hypotheses.patch).toHaveBeenCalledWith('hyp-1', { experimentId: 'exp-1' });

    const missing = makeHarness({ doc, experimentScope: null });
    await expect(missing.service.attachExperiment('u1', 'hyp-1', 'exp-x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('runDetail：只读投影 workflowRun（步骤事实 + 版本 + 终态输出），不写 run 生命周期', async () => {
    const doc = makeDoc({
      status: 'running',
      loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW.toISOString() },
    });
    const h = makeHarness({
      doc,
      run: makeRun({
        status: 'waiting',
        steps: [{
          stepId: 'human_review', stepIndex: 2, stepType: 'approval', status: 'waiting', attempt: 1,
          approvalId: 'appr-1', externalActionId: null, agentRunId: null, startedAt: NOW, completedAt: null, errorCode: null,
        }],
      }),
    });
    const detail = await h.service.runDetail('u1', 'hyp-1');
    expect(detail.run).toMatchObject({
      runId: 'run-1', workflowId: 'wf-1', status: 'waiting', attempt: 1,
      steps: [expect.objectContaining({ stepId: 'human_review', stepType: 'approval', approvalId: 'appr-1' })],
    });
    expect(h.prisma.workflowRun.findUnique).toHaveBeenCalledTimes(1); // 只读
  });
});
