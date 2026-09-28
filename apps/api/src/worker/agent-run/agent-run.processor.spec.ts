import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRunProcessor } from './agent-run.processor';
import { AGENT_RUN_CANCEL_CHANNEL } from '../../modules/agent-runs/agent-runs.service';

/**
 * X-01 单测：在途 run 登记为集合（Map<runId, ActiveRun>），取消快通道与优雅停机覆盖**全部** in-flight。
 * 回归靶心：原实现 `active` 为单值，worker concurrency>1 时只记住"最近一个"——
 *  ① cancel 提示对早先那个 run 完全不生效（白等心跳 15s）；
 *  ② 优雅停机只 release 一个 lease，其余 run 需等 lease TTL 过期才能被接管。
 * 契约：claim 失败不登记；正常结束时只删除自己的键；停机幂等（lifecycle 钩子会再调一次）。
 */
describe('AgentRunProcessor（X-01：in-flight 集合——cancel/shutdown 覆盖全部 active）', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { delete process.env.AGENT_RUN_WORKER_CONCURRENCY; });

  /** 可挂起的 driver：手动 resolve 每条 run，模拟"同时多个 in-flight" */
  function makeRig() {
    const gates = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
    const started: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const controls = new Map<string, { active: boolean }>();
    const driver = {
      execute: vi.fn((runId: string, signal: AbortSignal, ctl: { active: boolean }) => {
        started.push(runId);
        signals.set(runId, signal);
        controls.set(runId, ctl);
        return new Promise((resolve, reject) => gates.set(runId, { resolve, reject }));
      }),
    };
    const lease = {
      claim: vi.fn().mockResolvedValue({ acquired: true, workerId: 'w1', status: 'running' }),
      leaseTtlMs: vi.fn().mockResolvedValue(30_000),
      heartbeatIntervalMs: vi.fn().mockResolvedValue(60_000), // 测试窗口内不触发心跳
      release: vi.fn().mockResolvedValue(undefined),
      renew: vi.fn().mockResolvedValue({ count: 1 }),
      getStatus: vi.fn().mockResolvedValue({ status: 'running' }),
    };
    let cancelHandler: ((event: Record<string, unknown>) => void) | undefined;
    const events = {
      subscribe: vi.fn(async (channel: string, handler: (event: Record<string, unknown>) => void) => {
        if (channel === AGENT_RUN_CANCEL_CHANNEL) cancelHandler = handler;
      }),
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const metrics = { recordRunDuration: vi.fn().mockResolvedValue(undefined) };
    const processor = new AgentRunProcessor(lease as never, driver as never, events as never, metrics as never);
    return {
      processor, lease, events, driver, metrics, started, signals, controls, gates,
      cancel: (runId: string) => cancelHandler?.({ runId }),
      hasCancelHandler: () => !!cancelHandler,
    };
  }

  const job = (runId: string) => ({ data: { runId } }) as never;

  it('cancel 快通道：两个 in-flight 时，对"较早那个" run 的取消提示同样生效（原单值实现在此失效）', async () => {
    const rig = makeRig();
    await rig.processor.onModuleInit();
    expect(rig.hasCancelHandler()).toBe(true);

    const p1 = rig.processor.process(job('run-1'));
    const p2 = rig.processor.process(job('run-2'));
    await vi.waitFor(() => expect(rig.started).toEqual(['run-1', 'run-2']));

    rig.cancel('run-1'); // 先启动、非"最近一个"
    expect(rig.signals.get('run-1')!.aborted).toBe(true);
    expect(rig.signals.get('run-2')!.aborted).toBe(false); // 绝不误伤其他 in-flight

    rig.cancel('run-2');
    expect(rig.signals.get('run-2')!.aborted).toBe(true);

    // 无匹配 in-flight（非本进程在途）→ 不抛错（DB/心跳兜底）
    expect(() => rig.cancel('run-unknown')).not.toThrow();

    rig.gates.get('run-1')!.resolve({ status: 'cancelled', taskRefs: [], approvalRefs: [], delegationRefs: [] });
    rig.gates.get('run-2')!.resolve({ status: 'completed', taskRefs: [], approvalRefs: [], delegationRefs: [] });
    await Promise.all([p1, p2]);
  });

  it('优雅停机：全部 in-flight 都被 release + abort + controls.active=false（job 抛错交回重试）', async () => {
    const rig = makeRig();
    const p1 = rig.processor.process(job('run-1'));
    const p2 = rig.processor.process(job('run-2'));
    const p3 = rig.processor.process(job('run-3'));
    await vi.waitFor(() => expect(rig.started).toHaveLength(3));

    await rig.processor.onApplicationShutdown();

    expect(rig.lease.release).toHaveBeenCalledTimes(3);
    expect(rig.lease.release.mock.calls.map((c) => c[0]).sort()).toEqual(['run-1', 'run-2', 'run-3']);
    for (const id of ['run-1', 'run-2', 'run-3']) {
      expect(rig.signals.get(id)!.aborted).toBe(true);
      expect(rig.controls.get(id)!.active).toBe(false); // Engine 跳过终态写入
    }

    // 停机后 job 必须以失败退出（BullMQ attempts 重试 → 新 worker resume），绝不假装完成
    rig.gates.get('run-1')!.resolve({ status: 'completed', taskRefs: [], approvalRefs: [], delegationRefs: [] });
    rig.gates.get('run-2')!.resolve({ status: 'completed', taskRefs: [], approvalRefs: [], delegationRefs: [] });
    rig.gates.get('run-3')!.resolve({ status: 'completed', taskRefs: [], approvalRefs: [], delegationRefs: [] });
    await expect(p1).rejects.toThrow(/shutdown/);
    await expect(p2).rejects.toThrow(/shutdown/);
    await expect(p3).rejects.toThrow(/shutdown/);

    // 幂等：lifecycle 阶段会再调一次 —— 集合已空 → no-op（不重复 release）
    await rig.processor.onApplicationShutdown();
    expect(rig.lease.release).toHaveBeenCalledTimes(3);
  });

  it('结束清理是逐条的：run-1 完成后从集合移除，run-2 仍可被 cancel 命中', async () => {
    const rig = makeRig();
    await rig.processor.onModuleInit();
    const p1 = rig.processor.process(job('run-1'));
    const p2 = rig.processor.process(job('run-2'));
    await vi.waitFor(() => expect(rig.started).toHaveLength(2));

    rig.gates.get('run-1')!.resolve({ status: 'completed', taskRefs: [], approvalRefs: [], delegationRefs: [] });
    await p1;
    expect(rig.metrics.recordRunDuration).toHaveBeenCalledWith('agent_run', 'run-1', expect.any(Number), expect.objectContaining({ outcome: 'finished' }));

    rig.cancel('run-1'); // 已结束 → 不再是 in-flight（不命中，无副作用）
    expect(rig.signals.get('run-1')!.aborted).toBe(false);
    rig.cancel('run-2');
    expect(rig.signals.get('run-2')!.aborted).toBe(true);

    rig.gates.get('run-2')!.resolve({ status: 'cancelled', taskRefs: [], approvalRefs: [], delegationRefs: [] });
    await p2;
  });

  it('claim 失败（重复 job / 他 worker 持有）→ 不登记 in-flight，停机不触碰其 lease', async () => {
    const rig = makeRig();
    rig.lease.claim.mockResolvedValue({ acquired: false, status: 'running', workerId: 'other' });
    await rig.processor.process(job('run-x'));
    expect(rig.driver.execute).not.toHaveBeenCalled();
    await rig.processor.onApplicationShutdown();
    expect(rig.lease.release).not.toHaveBeenCalled();
  });

  it('非法 payload（无 runId）→ 直接完成，不登记、不 claim', async () => {
    const rig = makeRig();
    await rig.processor.process({ data: {} } as never);
    expect(rig.lease.claim).not.toHaveBeenCalled();
    expect(rig.started).toHaveLength(0);
  });

  it('停机（controls.active=false）时 run 时长采样归因为 shutdown', async () => {
    const rig = makeRig();
    const p = rig.processor.process(job('run-s'));
    await vi.waitFor(() => expect(rig.started).toEqual(['run-s']));
    await rig.processor.onApplicationShutdown();
    rig.gates.get('run-s')!.resolve({ status: 'completed', taskRefs: [], approvalRefs: [], delegationRefs: [] });
    await expect(p).rejects.toThrow();
    expect(rig.metrics.recordRunDuration).toHaveBeenCalledWith('agent_run', 'run-s', expect.any(Number), expect.objectContaining({ outcome: 'shutdown' }));
  });
});
