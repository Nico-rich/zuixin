import { describe, it, expect } from 'vitest';
import { MockVideoAdapter } from './mock-video.adapter';

describe('MockVideoAdapter', () => {
  it('submit 返回 remoteTaskId；getStatus 先 processing 后 completed（含 data URL 结果）', async () => {
    const adapter = new MockVideoAdapter();
    const { remoteTaskId } = await adapter.submit({ prompt: 'x', model: 'mock-video-1', duration: 5 });
    expect(remoteTaskId).toContain('mock-video-');
    const early = await adapter.getStatus(remoteTaskId);
    expect(early.status).toBe('processing');

    // 模拟 3 秒后（替身完成时间）
    const task = (adapter as unknown as { tasks: Map<string, { startedAt: number }> }).tasks.get(remoteTaskId)!;
    task.startedAt -= 3001;
    const done = await adapter.getStatus(remoteTaskId);
    expect(done.status).toBe('completed');
    expect(done.resultUrl).toContain('data:video/mp4;base64,');
  });

  it('未知 remoteTaskId → failed', async () => {
    const adapter = new MockVideoAdapter();
    expect(await adapter.getStatus('nope')).toMatchObject({ status: 'failed' });
  });
});
