import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Queue } from 'bullmq';
import { QUEUE_ADD_TIMEOUT_MS, addJobBestEffort, addJobBounded } from './bounded-add';
import { AppError } from '../../common/errors/app-error';

afterEach(() => { vi.useRealTimers(); });

const fakeQueue = (add: unknown, name = 'agent-run') => ({ name, add }) as unknown as Queue;

describe('Pre-M9 G4：queue.add 有界投递 + 显式失败', () => {
  it('正常投递：返回 Job（透传 add 结果）', async () => {
    const job = { id: 'run-1' };
    const add = vi.fn().mockResolvedValue(job);
    await expect(addJobBounded(fakeQueue(add), 'execute', { runId: 'run-1' }, undefined, 'create')).resolves.toBe(job);
    expect(add).toHaveBeenCalledWith('execute', { runId: 'run-1' }, undefined);
  });

  it('投递挂起（队列后端不可达）→ AppError(INTERNAL)（显式失败，绝不无限挂起）', async () => {
    vi.useFakeTimers();
    const add = vi.fn(() => new Promise(() => undefined));
    const p = addJobBounded(fakeQueue(add), 'execute', { runId: 'run-1' }, undefined, 'create');
    const assertion = expect(p).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('队列投递超时') });
    await vi.advanceTimersByTimeAsync(QUEUE_ADD_TIMEOUT_MS + 100);
    await assertion;
  });

  it('BullMQ 自身错误原样透传（不伪装成投递超时）', async () => {
    const add = vi.fn().mockRejectedValue(new Error('Duplicate job id'));
    await expect(addJobBounded(fakeQueue(add), 'execute', { runId: 'r' })).rejects.toThrow('Duplicate job id');
  });

  it('addJobBestEffort：失败/超时只告警不冒泡（返回 false），成功返回 true', async () => {
    vi.useFakeTimers();
    const hanging = fakeQueue(vi.fn(() => new Promise(() => undefined)));
    const p = addJobBestEffort(hanging, 'execute', { runId: 'r' }, undefined, 'wake');
    const assertion = expect(p).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(QUEUE_ADD_TIMEOUT_MS + 100);
    await assertion;
    vi.useRealTimers();
    const ok = fakeQueue(vi.fn().mockResolvedValue({ id: 'j' }));
    await expect(addJobBestEffort(ok, 'execute', { runId: 'r' })).resolves.toBe(true);
    await expect(addJobBestEffort(fakeQueue(vi.fn().mockRejectedValue(new AppError('INTERNAL' as never, 'x'))), 'execute', {})).resolves.toBe(false);
  });
});
