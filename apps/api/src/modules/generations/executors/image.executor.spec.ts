import { describe, it, expect, vi } from 'vitest';
import { ImageExecutor } from './image.executor';
import { MediaRemoteQuery } from '../media-types';

/**
 * Pre-M9 G7：图片执行器的**远端恢复查询**（工作进程崩溃后按 remoteTaskId 反查 provider 真实状态）。
 * M9-P3：执行路径的候选/回退改由 RoutingService 决策（ModelResolverService.resolveMediaRoute），
 * 本文件只覆盖不涉及选模的恢复查询路径（路由接线由 routing.service.spec / media executor 集成断言覆盖）。
 */
function makeExecutor(adapter: Record<string, unknown> | null) {
  const imageManager = {
    resolve: vi.fn(async (modelId: string) => {
      if (adapter === null) throw new Error(`生图模型不可用: ${modelId}`); // resolve 失败（模型停用/provider 未加载）
      return { providerId: 'p1', providerName: 'Mock', modelId, apiModelId: 'api-1', timeoutMs: 1000, adapter };
    }),
  };
  const executor = new ImageExecutor(
    { resolveMediaRoute: vi.fn() } as never, imageManager as never, {} as never, {} as never,
  );
  return { executor, imageManager };
}

const query = (over: Partial<MediaRemoteQuery> = {}): MediaRemoteQuery => ({
  taskId: 't1', remoteTaskId: 'r1', modelId: 'm1', providerId: 'p1', input: {}, deadline: Date.now() + 5_000, ...over,
});

describe('Pre-M9 G7：ImageExecutor.queryRemoteStatus', () => {
  it('远端已完成 → completed（urls → files 归因，与正常执行一致）', async () => {
    const getStatus = vi.fn().mockResolvedValue({ status: 'completed', progress: 100, resultUrls: ['https://x.test/a.png', 'https://x.test/b.png'] });
    const { executor } = makeExecutor({ kind: 'image', submit: vi.fn(), getStatus });
    await expect(executor.queryRemoteStatus(query())).resolves.toEqual({
      status: 'completed',
      result: {
        files: [{ url: 'https://x.test/a.png', mimeType: 'image/png' }, { url: 'https://x.test/b.png', mimeType: 'image/png' }],
        imageCount: 2, videoSeconds: 0, providerId: 'p1', modelId: 'm1',
      },
    });
    // 查询携带 deadline 信号（绝不无限期挂着清扫周期）
    expect(getStatus.mock.calls[0][1]?.signal).toBeDefined();
  });

  it('远端完成但无 urls → failed（不谎报完成）', async () => {
    const { executor } = makeExecutor({ kind: 'image', submit: vi.fn(), getStatus: vi.fn().mockResolvedValue({ status: 'completed' }) });
    await expect(executor.queryRemoteStatus(query())).resolves.toEqual({ status: 'failed', error: '生图完成但无结果' });
  });

  it('远端已失败 → failed（文案来自 provider）', async () => {
    const { executor } = makeExecutor({ kind: 'image', submit: vi.fn(), getStatus: vi.fn().mockResolvedValue({ status: 'failed', error: '内容审核未通过' }) });
    await expect(executor.queryRemoteStatus(query())).resolves.toEqual({ status: 'failed', error: '内容审核未通过' });
  });

  it('远端仍在执行 → processing', async () => {
    const { executor } = makeExecutor({ kind: 'image', submit: vi.fn(), getStatus: vi.fn().mockResolvedValue({ status: 'processing' }) });
    await expect(executor.queryRemoteStatus(query())).resolves.toEqual({ status: 'processing' });
  });

  it('同步型 provider（无 getStatus，如 mock/openai-image）→ null（无远端任务概念，不可恢复）', async () => {
    const { executor } = makeExecutor({ kind: 'image', generate: vi.fn() });
    await expect(executor.queryRemoteStatus(query())).resolves.toBeNull();
  });

  it('无 modelId → null 且不解析适配器', async () => {
    const { executor, imageManager } = makeExecutor({ kind: 'image', submit: vi.fn(), getStatus: vi.fn() });
    await expect(executor.queryRemoteStatus(query({ modelId: null }))).resolves.toBeNull();
    expect(imageManager.resolve).not.toHaveBeenCalled();
  });

  it('适配器解析失败（模型停用/provider 未加载）→ 上抛，由调用方归一为 unknown（绝不当成 failed）', async () => {
    const { executor } = makeExecutor(null);
    await expect(executor.queryRemoteStatus(query())).rejects.toThrow('生图模型不可用');
  });
});
