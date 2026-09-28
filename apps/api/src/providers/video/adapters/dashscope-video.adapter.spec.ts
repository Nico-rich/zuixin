import { describe, it, expect, vi } from 'vitest';
import { DashScopeVideoAdapter } from './dashscope-video.adapter';

const cfg = { baseUrl: 'https://dashscope.example.com', apiKey: 'k' };

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function hangingFetch() {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = vi.fn((url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Promise<Response>((_, reject) => {
      const sig = init?.signal;
      if (!sig) return;
      if (sig.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    });
  });
  return { seen, fetchFn };
}

describe('Pre-M9 G5：DashScope 视频适配器（真实超时 + 可中止 + 轮询有界）', () => {
  it('submit/getStatus 都把组合信号交给 fetch（整体 deadline + 单请求超时）', async () => {
    const { seen, fetchFn } = hangingFetch();
    const adapter = new DashScopeVideoAdapter({ ...cfg, timeoutMs: 20 }, { fetch: fetchFn });
    await expect(adapter.submit({ prompt: 'p', model: 'm', signal: AbortSignal.timeout(5_000) })).rejects.toThrow();
    await expect(adapter.getStatus('t-1', { signal: AbortSignal.timeout(5_000) })).rejects.toThrow();
    expect(seen).toHaveLength(2);
    for (const req of seen) expect(req.init?.signal).toBeDefined();
    expect(seen[0].url).toContain('/services/aigc/video-generation/video-synthesis');
    expect(seen[1].url).toContain('/tasks/t-1');
  });

  it('单请求超时 → AbortError；整体 deadline 到点 → MEDIA_TASK_TIMEOUT（两者语义分离）', async () => {
    const a = new DashScopeVideoAdapter({ ...cfg, timeoutMs: 20 }, { fetch: hangingFetch().fetchFn });
    await expect(a.submit({ prompt: 'p', model: 'm' })).rejects.toMatchObject({
      name: 'AbortError', message: expect.stringContaining('请求超时'),
    });
    const b = new DashScopeVideoAdapter({ ...cfg, timeoutMs: 5_000 }, { fetch: hangingFetch().fetchFn });
    await expect(b.submit({ prompt: 'p', model: 'm', signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'MEDIA_TASK_TIMEOUT',
    });
  });

  it('视频任务耗时长：单请求超时可远大于轮询间隔（不被任务整体时长误伤）', async () => {
    const adapter = new DashScopeVideoAdapter({ ...cfg, timeoutMs: 5_000 }, {
      fetch: vi.fn(async () => jsonResponse({ output: { task_status: 'RUNNING' } })),
    });
    await expect(adapter.getStatus('t-1', { signal: AbortSignal.timeout(60_000) })).resolves.toEqual({ status: 'processing' });
  });

  it('响应映射不变：SUCCEEDED→completed（无 url→failed）、FAILED/CANCELED→failed、其它→processing', async () => {
    const make = (body: unknown, status = 200) => new DashScopeVideoAdapter({ ...cfg, timeoutMs: 50 }, { fetch: vi.fn(async () => jsonResponse(body, status)) });
    await expect(make({ output: { task_status: 'SUCCEEDED', video_url: 'v.mp4' } }).getStatus('t')).resolves.toEqual({ status: 'completed', progress: 100, resultUrl: 'v.mp4' });
    await expect(make({ output: { task_status: 'SUCCEEDED' } }).getStatus('t')).resolves.toEqual({ status: 'failed', error: '视频完成但无结果' });
    await expect(make({ output: { task_status: 'CANCELED' } }).getStatus('t')).resolves.toEqual({ status: 'failed', error: '万相视频任务失败' });
    await expect(make({ output: { task_status: 'PENDING' } }).getStatus('t')).resolves.toEqual({ status: 'processing' });
    await expect(make({}, 500).submit({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ status: 500 });
  });
});
