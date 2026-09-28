import { describe, it, expect, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { StepRowFact, WorkflowCompensationService } from './workflow-compensation.service';
import { WorkflowDefinition } from './workflow-types';

const DEF: WorkflowDefinition = {
  triggers: [],
  steps: [
    { id: 'a', type: 'tool', tool: { name: 'read.a', arguments: {} }, compensate: 'undo_a' },
    { id: 'b', type: 'tool', tool: { name: 'read.b', arguments: {} }, compensate: 'undo_b' },
    { id: 'boom', type: 'tool', tool: { name: 'read.boom', arguments: {} } },
    { id: 'undo_a', type: 'tool', tool: { name: 'undo.a', arguments: {} } },
    { id: 'undo_b', type: 'tool', tool: { name: 'undo.b', arguments: {} } },
  ],
};

const row = (over: Partial<StepRowFact> & { stepIndex: number; stepId: string }): StepRowFact => ({
  status: 'completed', attempt: 1, output: null, errorCode: null, errorMessage: null, ...over,
});

function makeService() {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const creates: Array<Record<string, unknown>> = [];
  const prisma = {
    workflowStepRun: {
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => { updates.push(args); return {}; }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => { creates.push(args.data); return {}; }),
    },
  } as unknown as PrismaService;
  return { service: new WorkflowCompensationService(prisma), updates, creates };
}

/**
 * M9-P4 补偿链（单测）：逆序、幂等（锚点行）、失败记录（绝不重试）、中止不写、类型收敛。
 */
describe('WorkflowCompensationService（M9-P4 补偿链）', () => {
  it('plan：仅"已成功且声明 compensate"的步骤，按 stepIndex 逆序（b 先于 a）', () => {
    const { service } = makeService();
    const rows = [
      row({ stepIndex: 0, stepId: 'a' }),
      row({ stepIndex: 1, stepId: 'b' }),
      row({ stepIndex: 2, stepId: 'boom', status: 'failed', errorCode: 'PROVIDER_UNKNOWN' }),
    ];
    expect(service.plan(DEF, rows)).toEqual([
      { targetStepId: 'b', targetStepIndex: 1, compensateStepId: 'undo_b', compensateStepIndex: 4 },
      { targetStepId: 'a', targetStepIndex: 0, compensateStepId: 'undo_a', compensateStepIndex: 3 },
    ]);
    // 失败/跳过步骤绝不补偿（只有成功步骤需要回滚）
    expect(service.plan(DEF, [row({ stepIndex: 2, stepId: 'boom', status: 'skipped' })])).toEqual([]);
    // 未声明 compensate 的成功步骤不进计划
    expect(service.plan(DEF, [row({ stepIndex: 2, stepId: 'boom' })])).toEqual([]);
  });

  it('run：逆序执行并记录 completed（各调用一次，锚点行 stepType=compensation）', async () => {
    const { service, updates, creates } = makeService();
    const calls: number[] = [];
    const records = await service.run({
      runId: 'run-1', def: DEF,
      rows: [row({ stepIndex: 0, stepId: 'a' }), row({ stepIndex: 1, stepId: 'b' }), row({ stepIndex: 2, stepId: 'boom', status: 'failed' })],
      invoke: async (_step, index) => { calls.push(index); return { undone: index }; },
    });
    expect(calls).toEqual([4, 3]); // 逆序：先 undo_b(4) 后 undo_a(3)
    expect(records.map((r) => [r.stepId, r.compensateStepId, r.stepIndex, r.status])).toEqual([
      ['b', 'undo_b', 4, 'completed'], ['a', 'undo_a', 3, 'completed'],
    ]);
    // 锚点行：无既有行 → create（stepType=compensation）
    expect(creates.map((c) => [c.stepId, c.stepIndex, c.stepType, c.status])).toEqual([
      ['undo_b', 4, 'compensation', 'completed'], ['undo_a', 3, 'compensation', 'completed'],
    ]);
    expect(updates).toHaveLength(0);
  });

  it('run 幂等：锚点行已 completed → **绝不重复执行**（invoke 不被调用），记录仍完整', async () => {
    const { service, updates, creates } = makeService();
    const invoke = vi.fn(async () => ({ ok: true }));
    const records = await service.run({
      runId: 'run-1', def: DEF,
      rows: [
        row({ stepIndex: 0, stepId: 'a' }), row({ stepIndex: 1, stepId: 'b' }),
        row({ stepIndex: 2, stepId: 'boom', status: 'failed' }),
        row({ stepIndex: 4, stepId: 'undo_b', status: 'completed', output: { undone: 4 } }), // 上一轮已补偿
      ],
      invoke,
    });
    expect(invoke).toHaveBeenCalledTimes(1); // 只补未做的 undo_a
    // undo_b(4) 已有 completed 锚点行 → 只读记录、不写；undo_a(3) 首跑 → create（锚点行由 (runId,stepIndex) 唯一约束保证不重复）
    expect(updates).toHaveLength(0);
    expect(creates.map((c) => [c.stepId, c.stepIndex, c.status])).toEqual([['undo_a', 3, 'completed']]);
    expect(records.map((r) => [r.compensateStepId, r.status])).toEqual([['undo_b', 'completed'], ['undo_a', 'completed']]);
  });

  it('run：补偿失败**记录后继续**（绝不重试、绝不中断整条链）', async () => {
    const { service, creates } = makeService();
    const invoke = vi.fn(async (_step, index: number) => {
      if (index === 4) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, 'undo_b 远端拒绝');
      return { ok: true };
    });
    const records = await service.run({
      runId: 'run-1', def: DEF,
      rows: [row({ stepIndex: 0, stepId: 'a' }), row({ stepIndex: 1, stepId: 'b' }), row({ stepIndex: 2, stepId: 'boom', status: 'failed' })],
      invoke,
    });
    expect(invoke).toHaveBeenCalledTimes(2); // 失败项绝不重试（各调用一次）
    expect(records).toEqual([
      { stepId: 'b', compensateStepId: 'undo_b', stepIndex: 4, status: 'failed', errorCode: 'PROVIDER_UNKNOWN', errorMessage: 'undo_b 远端拒绝' },
      { stepId: 'a', compensateStepId: 'undo_a', stepIndex: 3, status: 'completed' },
    ]);
    // 首跑（无既有锚点行）→ create；失败项也落盘记录，绝不吞掉
    expect(creates.map((c) => [c.stepId, c.status, c.errorCode ?? null])).toEqual([
      ['undo_b', 'failed', 'PROVIDER_UNKNOWN'], ['undo_a', 'completed', null],
    ]);
  });

  it('run：lease fencing 中止 → skipped 且**不写任何行**、不执行后续补偿', async () => {
    const { service, updates, creates } = makeService();
    const controller = new AbortController();
    const invoke = vi.fn(async () => { controller.abort(); return { ok: true }; });
    const records = await service.run({
      runId: 'run-1', def: DEF,
      rows: [row({ stepIndex: 0, stepId: 'a' }), row({ stepIndex: 1, stepId: 'b' }), row({ stepIndex: 2, stepId: 'boom', status: 'failed' })],
      signal: controller.signal,
      invoke,
    });
    expect(invoke).toHaveBeenCalledTimes(1); // 中止后绝不继续
    expect(updates).toHaveLength(0);
    expect(creates).toHaveLength(0);
    expect(records).toEqual([{ stepId: 'b', compensateStepId: 'undo_b', stepIndex: 4, status: 'skipped', errorCode: 'AGENT_CANCELLED', errorMessage: '执行已中止（lease fencing）' }]);
  });

  it('run：补偿目标类型不支持（output/wait/agent）→ 记录 failed，绝不执行', async () => {
    const { service } = makeService();
    const def: WorkflowDefinition = {
      triggers: [],
      steps: [
        { id: 'a', type: 'tool', tool: { name: 'read.a', arguments: {} }, compensate: 'undo' },
        { id: 'undo', type: 'output', output: {} },
      ],
    };
    const invoke = vi.fn(async () => ({}));
    const records = await service.run({ runId: 'run-1', def, rows: [row({ stepIndex: 0, stepId: 'a' })], invoke });
    expect(invoke).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({ status: 'failed', errorCode: 'VALIDATION_ERROR' });
  });
});
