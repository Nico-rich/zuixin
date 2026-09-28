import { describe, it, expect, vi } from 'vitest';
import { DashScopeImageAdapter } from './dashscope-image.adapter';

const cfg = { baseUrl: 'https://dashscope.example.com', apiKey: 'k' };

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

/** 记录 init 的 fetch；带信号时挂起到中止（忠实模拟"连接建立后无响应"） */
function hangingFetch() {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = vi.fn((url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Promise<Response>((_, reject) => {
      const sig = init?.signal;
      if (!sig) return; // 无信号 → 永久挂起（正是 G5 要修的缺陷）
      if (sig.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    });
  });
  return { seen, fetchFn };
}

describe('Pre-M9 G5：DashScope 生图适配器（真实超时 + 可中止）', () => {
  it('submit 把 signal 真正交给 fetch（组合：整体 deadline + 单请求超时）——AbortSignal 不再是死代码', async () => {
    const { seen, fetchFn } = hangingFetch();
    const adapter = new DashScopeImageAdapter({ ...cfg, timeoutMs: 20 }, { fetch: fetchFn });
    const external = AbortSignal.timeout(5_000);
    await expect(adapter.submit({ prompt: 'p', model: 'm', signal: external })).rejects.toThrow();
    const signal = seen[0].init?.signal as AbortSignal | undefined;
    expect(signal).toBeDefined();
    expect(signal).not.toBe(external); // 组合后的信号（any），而非直接透传
    expect(seen[0].url).toContain('/services/aigc/text2image/image-synthesis');
    expect(seen[0].init?.method).toBe('POST');
  });

  it('单请求超时（连接/响应/读体无响应）→ AbortError（mapProviderError 归一为 PROVIDER_TIMEOUT，可回退）', async () => {
    const { fetchFn } = hangingFetch();
    const adapter = new DashScopeImageAdapter({ ...cfg, timeoutMs: 20 }, { fetch: fetchFn });
    await expect(adapter.submit({ prompt: 'p', model: 'm' })).rejects.toMatchObject({
      name: 'AbortError', message: expect.stringContaining('请求超时'),
    });
  });

  it('整体 deadline 已到 → MEDIA_TASK_TIMEOUT（AppError，非重试：回退另一个 provider 无意义）', async () => {
    const { fetchFn } = hangingFetch();
    const adapter = new DashScopeImageAdapter({ ...cfg, timeoutMs: 5_000 }, { fetch: fetchFn });
    const aborted = AbortSignal.abort();
    await expect(adapter.submit({ prompt: 'p', model: 'm', signal: aborted })).rejects.toMatchObject({
      code: 'MEDIA_TASK_TIMEOUT',
    });
  });

  it('缺省 timeoutMs 时兜底 60s（与 provider.timeoutMs 默认一致），不出现"无超时"路径', async () => {
    const { seen, fetchFn } = hangingFetch();
    const adapter = new DashScopeImageAdapter({ ...cfg }, { fetch: fetchFn });
    void adapter.submit({ prompt: 'p', model: 'm' }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    expect(seen[0].init?.signal).toBeDefined();
  });

  it('submit 成功：解析 task_id；失败/异常响应保留 status（既有语义不变）', async () => {
    const ok = new DashScopeImageAdapter({ ...cfg, timeoutMs: 50 }, { fetch: vi.fn(async () => jsonResponse({ output: { task_id: 't-1' } })) });
    await expect(ok.submit({ prompt: 'p', model: 'm' })).resolves.toEqual({ remoteTaskId: 't-1' });
    const noId = new DashScopeImageAdapter({ ...cfg, timeoutMs: 50 }, { fetch: vi.fn(async () => jsonResponse({ output: {} })) });
    await expect(noId.submit({ prompt: 'p', model: 'm' })).rejects.toThrow('缺少 task_id');
    const bad = new DashScopeImageAdapter({ ...cfg, timeoutMs: 50 }, { fetch: vi.fn(async () => jsonResponse({}, 429)) });
    await expect(bad.submit({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ status: 429 });
  });

  it('getStatus：接受整体 deadline 信号、超时中止；轮询响应映射（SUCCEEDED/FAILED/processing）', async () => {
    const { fetchFn } = hangingFetch();
    const adapter = new DashScopeImageAdapter({ ...cfg, timeoutMs: 20 }, { fetch: fetchFn });
    await expect(adapter.getStatus('t-1', { signal: AbortSignal.timeout(5_000) })).rejects.toMatchObject({ name: 'AbortError' });

    const succeeded = new DashScopeImageAdapter({ ...cfg, timeoutMs: 50 }, {
      fetch: vi.fn(async () => jsonResponse({ output: { task_status: 'SUCCEEDED', results: [{ url: 'u1' }, {}] } })),
    });
    await expect(succeeded.getStatus('t-1')).resolves.toEqual({ status: 'completed', resultUrls: ['u1'] });
    const failed = new DashScopeImageAdapter({ ...cfg, timeoutMs: 50 }, {
      fetch: vi.fn(async () => jsonResponse({ output: { task_status: 'FAILED', message: '内容不合规' } })),
    });
    await expect(failed.getStatus('t-1')).resolves.toEqual({ status: 'failed', error: '内容不合规' });
    const processing = new DashScopeImageAdapter({ ...cfg, timeoutMs: 50 }, {
      fetch: vi.fn(async () => jsonResponse({ output: { task_status: 'RUNNING' } })),
    });
    await expect(processing.getStatus('t-1')).resolves.toEqual({ status: 'processing' });
  });
});
