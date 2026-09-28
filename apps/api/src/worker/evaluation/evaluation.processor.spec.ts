import { describe, it, expect, vi } from 'vitest';
import { Job } from 'bullmq';
import { EvaluationProcessor } from './evaluation.processor';
import { EVALUATION_RUN_CANCEL_CHANNEL } from '../../modules/evaluation/evaluation-runs.service';

/**
 * 评测 Worker 单测（离线）：payload 只认 {runId}；取消提示走 EventBus 快速通道（立即 abort 在途 case）；
 * 停机阶段 abort（已完成的事实保留）；观测指标独立命名（绝不混入 agent/workflow 指标）。
 */
function makeProcessor() {
  const handlers = new Map<string, (event: Record<string, unknown>) => void | Promise<void>>();
  let captured: AbortSignal | undefined;
  const gate = { release: () => undefined as void };
  const runner = {
    executeRun: vi.fn(async (runId: string, signal?: AbortSignal) => {
      captured = signal;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { runId, claimed: true, status: 'completed', completedCases: 2, failedCases: 0, results: 2 };
    }),
  };
  const events = {
    subscribe: vi.fn(async (channel: string, handler: (event: Record<string, unknown>) => void | Promise<void>) => {
      handlers.set(channel, handler);
    }),
  };
  const metrics = { recordMetric: vi.fn(async () => undefined) };
  const proc = new EvaluationProcessor(runner as never, events as never, metrics as never);
  return { proc, runner, events, metrics, handlers, signal: () => captured, gate };
}

const job = (data: unknown) => ({ data } as Job<{ runId?: string }>);

describe('EvaluationProcessor', () => {
  it('onModuleInit 订阅 cancel 通道（payload 仅 {runId}）', async () => {
    const h = makeProcessor();
    await h.proc.onModuleInit();
    expect(h.events.subscribe).toHaveBeenCalledWith(EVALUATION_RUN_CANCEL_CHANNEL, expect.any(Function));
    expect(h.handlers.has(EVALUATION_RUN_CANCEL_CHANNEL)).toBe(true);
  });

  it('非法 payload（无 runId）→ 直接返回，绝不猜测、绝不执行', async () => {
    const h = makeProcessor();
    await h.proc.process(job({}));
    await h.proc.process(job(undefined));
    expect(h.runner.executeRun).not.toHaveBeenCalled();
  });

  it('正常执行：调用 runner 并记录独立指标 evaluation_run_duration_ms（单位 ms）', async () => {
    const h = makeProcessor();
    const p = h.proc.process(job({ runId: 'run1' }));
    await vi.waitFor(() => expect(h.runner.executeRun).toHaveBeenCalled());
    h.gate.release();
    await p;
    expect(h.runner.executeRun).toHaveBeenCalledWith('run1', expect.anything());
    expect(h.metrics.recordMetric).toHaveBeenCalledTimes(1);
    const [name, value, unit, labels] = h.metrics.recordMetric.mock.calls[0] as unknown as [string, number, string, Record<string, unknown>];
    expect(name).toBe('evaluation_run_duration_ms');
    expect(unit).toBe('ms');
    expect(typeof value).toBe('number');
    expect(labels).toMatchObject({ runId: 'run1' });
  });

  it('cancel 提示命中在途 run → 立即 abort（DB 状态复查仍是兜底事实）', async () => {
    const h = makeProcessor();
    await h.proc.onModuleInit();
    const p = h.proc.process(job({ runId: 'run1' }));
    await vi.waitFor(() => expect(h.signal()).toBeDefined());
    expect(h.signal()?.aborted).toBe(false);
    await h.handlers.get(EVALUATION_RUN_CANCEL_CHANNEL)!({ runId: 'run1' });
    expect(h.signal()?.aborted).toBe(true);
    await p;
  });

  it('cancel 提示的 runId 不匹配 → 不误伤在途 run（绝不跨 run abort）', async () => {
    const h = makeProcessor();
    await h.proc.onModuleInit();
    const p = h.proc.process(job({ runId: 'run1' }));
    await vi.waitFor(() => expect(h.signal()).toBeDefined());
    await h.handlers.get(EVALUATION_RUN_CANCEL_CHANNEL)!({ runId: 'run-other' });
    await h.handlers.get(EVALUATION_RUN_CANCEL_CHANNEL)!({});
    expect(h.signal()?.aborted).toBe(false);
    h.gate.release();
    await p;
  });

  it('停机：onApplicationShutdown 与 finalizeLeases 阶段均 abort 在途执行（幂等）', async () => {
    const h = makeProcessor();
    const p = h.proc.process(job({ runId: 'run1' }));
    await vi.waitFor(() => expect(h.signal()).toBeDefined());
    await h.proc.onLifecycleStep('finalizeLeases');
    expect(h.signal()?.aborted).toBe(true);
    await h.proc.onApplicationShutdown(); // 幂等：再次 abort 不抛错
    await p;
    // 非 finalizeLeases 阶段是 no-op（不误伤，也绝不抛错）
    expect(h.proc.onLifecycleStep('drainHttp')).toBeInstanceOf(Promise);
  });

  it('runner 抛错 → 指标仍记录（finally），错误继续冒泡给 BullMQ（可重投）', async () => {
    const h = makeProcessor();
    h.runner.executeRun.mockRejectedValueOnce(new Error('boom'));
    await expect(h.proc.process(job({ runId: 'run1' }))).rejects.toThrow('boom');
    expect(h.metrics.recordMetric).toHaveBeenCalledTimes(1);
  });
});
