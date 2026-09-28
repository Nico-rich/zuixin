import { describe, it, expect, vi } from 'vitest';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { WorkflowWakeService } from './workflow-wake.service';

/**
 * M9-P4 时间窗 wait 的唤醒面（单测）：到期条件唤醒 / 早到重新武装 / 非时间等待不上手 / 终态绝不复活。
 * 不变量：判定完全依赖 DB 事实（落库期限），绝不依赖作业携带的期限，绝不提前前进。
 */
function makeService(over: {
  run?: { id: string; status: string; currentStep: number } | null;
  row?: { stepType: string; status: string; output: unknown } | null;
  wokenCount?: number;
} = {}) {
  const added: Array<{ data: unknown; opts: Record<string, unknown> }> = [];
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    workflowRun: {
      findUnique: vi.fn(async () => over.run ?? null),
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return { count: over.wokenCount ?? 1 };
      }),
    },
    workflowStepRun: {
      findUnique: vi.fn(async () => over.row ?? null),
    },
  } as unknown as PrismaService;
  const queue = {
    name: 'workflow',
    add: vi.fn(async (_name: string, data: unknown, opts: Record<string, unknown>) => {
      added.push({ data, opts });
      return { id: 'job-1' };
    }),
  };
  const service = new WorkflowWakeService(prisma, queue as never, { subscribe: vi.fn() } as never);
  return { service, added, updates, prisma };
}

const waitingTimeRow = (untilMs: number) => ({
  stepType: 'wait', status: 'waiting', output: { kind: 'time', waitingUntil: new Date(untilMs).toISOString() },
});

describe('WorkflowWakeService.wakeByWaitDue（M9-P4 时间窗 wait 唤醒）', () => {
  it('到期：waiting → queued（条件更新 + 清 lease）+ 放行 claim（绝不复活终态）', async () => {
    const { service, updates } = makeService({
      run: { id: 'run-1', status: 'waiting', currentStep: 1 },
      row: waitingTimeRow(Date.now() - 1_000), // 已到期
    });
    expect(await service.wakeByWaitDue('run-1')).toBe(true);
    expect(updates[0]).toMatchObject({ status: 'queued', workerId: null, leaseUntil: null, heartbeatAt: null });
  });

  it('早到（未到期）：**绝不提前前进** → 不上手 + 重新武装同一 jobId 的延迟作业（去重）', async () => {
    const until = Date.now() + 60_000;
    const { service, added, updates } = makeService({
      run: { id: 'run-1', status: 'waiting', currentStep: 1 },
      row: waitingTimeRow(until),
    });
    expect(await service.wakeByWaitDue('run-1')).toBe(false);
    expect(updates).toHaveLength(0); // 绝不改状态
    expect(added).toHaveLength(1);   // 重新武装（同一期限 → 同一 jobId）
    expect((added[0].opts as { jobId: string }).jobId).toBe(`wf-run-1-wait-${until}`);
    expect((added[0].data as { kind?: string }).kind).toBe('wait-wake');
  });

  it('等待对象是审批/子 run（非时间窗 wait）→ 不上手（各自唤醒路径负责）', async () => {
    const approvals = makeService({
      run: { id: 'run-1', status: 'waiting', currentStep: 1 },
      row: { stepType: 'approval', status: 'waiting', output: null },
    });
    expect(await approvals.service.wakeByWaitDue('run-1')).toBe(false);
    expect(approvals.added).toHaveLength(0);
    const noDeadline = makeService({
      run: { id: 'run-1', status: 'waiting', currentStep: 1 },
      row: { stepType: 'wait', status: 'waiting', output: { kind: 'agent_run', childRunId: 'c1' } },
    });
    expect(await noDeadline.service.wakeByWaitDue('run-1')).toBe(false);
  });

  it('run 已非 waiting：终态绝不复活；已 queued（其他唤醒路径已置位）→ 放行 claim', async () => {
    for (const status of ['completed', 'failed', 'cancelled', 'timeout', 'running']) {
      const { service, updates } = makeService({ run: { id: 'run-1', status, currentStep: 1 } });
      expect(await service.wakeByWaitDue('run-1')).toBe(false);
      expect(updates).toHaveLength(0);
    }
    const queued = makeService({ run: { id: 'run-1', status: 'queued', currentStep: 1 } });
    expect(await queued.service.wakeByWaitDue('run-1')).toBe(true);
    expect(queued.updates).toHaveLength(0); // 无状态可改，交给 claim 裁决
    const missing = makeService({ run: null });
    expect(await missing.service.wakeByWaitDue('run-x')).toBe(false);
  });

  it('到期但条件更新 count=0（与外部终态竞争）→ 不上手（绝不重复接管）', async () => {
    const { service, added } = makeService({
      run: { id: 'run-1', status: 'waiting', currentStep: 1 },
      row: waitingTimeRow(Date.now() - 1_000),
      wokenCount: 0,
    });
    expect(await service.wakeByWaitDue('run-1')).toBe(false);
    expect(added).toHaveLength(0);
  });

  it('scheduleWaitWake：唯一 jobId 含期限 + kind=wait-wake（不投递即唤醒）', async () => {
    const { service, added } = makeService({});
    const until = Date.now() + 3_000;
    expect(await service.scheduleWaitWake('run-1', until)).toBe(true);
    expect((added[0].opts as { jobId: string }).jobId).toBe(`wf-run-1-wait-${until}`);
    expect((added[0].opts as { delay: number }).delay).toBeGreaterThanOrEqual(0);
    expect(added[0].data).toEqual({ runId: 'run-1', kind: 'wait-wake' });
  });
});
