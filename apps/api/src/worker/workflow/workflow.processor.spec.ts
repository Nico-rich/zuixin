import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkflowProcessor } from './workflow.processor';

/**
 * Pre-M9 D5：workflow processor 心跳 fencing 单测。
 * 核心不变式：**lease 续期 count=0（已被接管）→ 立即中止当前执行**——不再进入下一步、不写任何状态；
 * 原实现只 warn 不停止，分叉 worker 会继续跑完后续步骤（agent 步骤重复建子 run / external_action 重复执行 = 双写）。
 */
type ExecOutcome = { outcome: 'continue' | 'done' | 'waiting'; waitUntilMs?: number };

function makeProcessor() {
  const lease = {
    claim: vi.fn(async () => ({ acquired: true, status: 'running' })),
    getStatus: vi.fn(async () => ({ status: 'running' })),
    renew: vi.fn(async () => ({ count: 1 })),
    release: vi.fn(async () => ({ count: 1 })),
  };
  const executor = {
    execute: vi.fn(async (
      _runId: string, _workerId: string, _signal?: AbortSignal,
    ): Promise<ExecOutcome> => ({ outcome: 'continue' })),
  };
  const wake = {
    watchChildRun: vi.fn(async () => undefined),
    scheduleWaitWake: vi.fn(async () => true),
    wakeByWaitDue: vi.fn(async () => true),
  };
  const prisma = { workflowRun: { findUnique: vi.fn(async () => ({ waitingOnAgentRunId: null })) } };
  const proc = new WorkflowProcessor(
    lease as never, executor as never, wake as never,
    { tickScheduled: vi.fn() } as never, { subscribe: vi.fn() } as never,
    prisma as never, { recordRunDuration: vi.fn(async () => undefined) } as never,
  );
  const activeAbort = () => (proc as unknown as { active: { abort: AbortController } | null }).active?.abort;
  return { proc, lease, executor, wake, prisma, activeAbort };
}

describe('WorkflowProcessor（Pre-M9 D5：lease fencing → 立即中止执行）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renew count=0（已被接管）→ abort 在途步骤、不再进入下一步、不写任何状态', async () => {
    const { proc, lease, executor, activeAbort } = makeProcessor();
    let releaseExec: (v: ExecOutcome) => void = () => undefined;
    executor.execute.mockImplementationOnce(() => new Promise((resolve) => { releaseExec = resolve as never; }));
    lease.renew.mockResolvedValue({ count: 0 }); // 第二个实例已接管 lease

    const running = proc.process({ data: { runId: 'run-1' } } as never);
    await vi.advanceTimersByTimeAsync(0); // claim + 第一步进入执行
    expect(executor.execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000); // 心跳 tick → renew=0 → abort
    expect(lease.renew).toHaveBeenCalled();
    expect(activeAbort()!.signal.aborted).toBe(true); // 在途调用已被中止（signal 下传执行器）

    releaseExec!({ outcome: 'continue' }); // 步骤返回后不得再推进一步
    await running;
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('run 已非 running（外部取消/恢复终态）→ 同样立即中止（与 agent run 语义对齐）', async () => {
    const { proc, lease, executor, activeAbort } = makeProcessor();
    executor.execute.mockImplementationOnce(() => new Promise(() => undefined)); // 永不返回
    lease.getStatus.mockResolvedValue({ status: 'cancelled' });

    void proc.process({ data: { runId: 'run-2' } } as never);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(activeAbort()!.signal.aborted).toBe(true);
  });

  it('正常路径：续期成功 → 不中止，逐步推进直至 done', async () => {
    const { proc, lease, executor } = makeProcessor();
    executor.execute
      .mockResolvedValueOnce({ outcome: 'continue' })
      .mockResolvedValueOnce({ outcome: 'done' });
    await proc.process({ data: { runId: 'run-3' } } as never);
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(lease.renew).not.toHaveBeenCalled(); // 短作业（<15s）不触发心跳
    // 下传执行器的 signal 全程未被中止（正常完成后 controller 已被回收）
    expect(executor.execute.mock.calls[0][2]!.aborted).toBe(false);
    expect(executor.execute.mock.calls[1][2]!.aborted).toBe(false);
  });

  it('claim 失败 → 不执行任何步骤（DB lease 是最终防线）', async () => {
    const { proc, lease, executor } = makeProcessor();
    lease.claim.mockResolvedValue({ acquired: false, status: 'running' });
    await proc.process({ data: { runId: 'run-4' } } as never);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('优雅停机：释放 lease + 中止在途执行（abort 先于返回，步骤 loop 不再写状态）', async () => {
    const { proc, lease, executor, activeAbort } = makeProcessor();
    let releaseExec: (v: ExecOutcome) => void = () => undefined;
    executor.execute.mockImplementationOnce(() => new Promise((resolve) => { releaseExec = resolve as never; }));
    const running = proc.process({ data: { runId: 'run-5' } } as never);
    await vi.advanceTimersByTimeAsync(0);
    await proc.onApplicationShutdown();
    expect(lease.release).toHaveBeenCalledWith('run-5', expect.any(String));
    expect(activeAbort()!.signal.aborted).toBe(true);
    releaseExec!({ outcome: 'continue' });
    await running;
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('M9-P4 wait：outcome=waiting 且带 waitUntilMs → 投递延迟唤醒（唯一 jobId 由 wake 服务负责）', async () => {
    const { proc, executor, wake } = makeProcessor();
    const until = Date.now() + 5_000;
    executor.execute.mockResolvedValueOnce({ outcome: 'waiting', waitUntilMs: until });
    await proc.process({ data: { runId: 'run-6' } } as never);
    expect(wake.scheduleWaitWake).toHaveBeenCalledWith('run-6', until);
    expect(executor.execute).toHaveBeenCalledTimes(1); // 等待即让出 lease，绝不自旋
  });

  it('M9-P4 wait：无 waitUntilMs 的 waiting（审批/子 run）绝不调度等待唤醒', async () => {
    const { proc, executor, wake } = makeProcessor();
    executor.execute.mockResolvedValueOnce({ outcome: 'waiting' });
    await proc.process({ data: { runId: 'run-7' } } as never);
    expect(wake.scheduleWaitWake).not.toHaveBeenCalled();
  });

  it('M9-P4 wait-wake：到期条件唤醒成功（waiting→queued）→ 继续 claim + 执行（唯一执行路径）', async () => {
    const { proc, executor, lease, wake } = makeProcessor();
    executor.execute.mockResolvedValueOnce({ outcome: 'done' });
    await proc.process({ data: { runId: 'run-8', kind: 'wait-wake' } } as never);
    expect(wake.wakeByWaitDue).toHaveBeenCalledWith('run-8');
    expect(lease.claim).toHaveBeenCalled();
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('M9-P4 wait-wake：未到期/已非等待态（wakeByWaitDue=false）→ 绝不 claim/绝不执行（绝不提前前进）', async () => {
    const { proc, executor, lease, wake } = makeProcessor();
    wake.wakeByWaitDue.mockResolvedValueOnce(false);
    await proc.process({ data: { runId: 'run-9', kind: 'wait-wake' } } as never);
    expect(lease.claim).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('migration 路径：{kind:scheduled} job 只触发 tickScheduled（不 claim/不执行）', async () => {
    const { proc, executor, lease } = makeProcessor();
    const triggers = (proc as unknown as { triggers: { tickScheduled: ReturnType<typeof vi.fn> } }).triggers;
    await proc.process({ data: { kind: 'scheduled', workflowId: 'wf-1' } } as never);
    expect(triggers.tickScheduled).toHaveBeenCalledWith('wf-1');
    expect(lease.claim).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });
});
