import { describe, it, expect, vi } from 'vitest';
import { VideoExecutor } from './video.executor';
import { ModelRouterService } from '../../../core/model-router/model-router.service';
import { CircuitBreakerService } from '../../../core/circuit-breaker/circuit-breaker.service';
import { KVStore } from '../../../core/circuit-breaker/kv-store.interface';
import { MediaExecContext, MediaRemoteQuery } from '../media-types';

const kv: KVStore = { incr: async () => 1, get: async () => null, set: async () => undefined, setNX: async () => true, del: async () => undefined };
const cb = new CircuitBreakerService(kv, () => 0);
const noSleep = async () => undefined;

function makeCtx(taskInput: Record<string, unknown>): MediaExecContext {
  return {
    task: {
      id: 't1', input: taskInput as never,
    } as never,
    deadline: Date.now() + 30 * 60_000,
    publishProgress: vi.fn().mockResolvedValue(undefined),
    setProviderAttempt: vi.fn().mockResolvedValue(undefined),
    setRemoteTaskId: vi.fn().mockResolvedValue(undefined),
  };
}

function makeExecutor(caps: Record<string, unknown> = {}) {
  const videoManager = {
    resolve: vi.fn().mockResolvedValue({
      providerId: 'p1', providerName: 'Mock', modelId: 'm1', apiModelId: 'mock-video-1', timeoutMs: 1000,
      adapter: {
        kind: 'video' as const,
        submit: vi.fn().mockResolvedValue({ remoteTaskId: 'r1' }),
        getStatus: vi.fn().mockResolvedValue({ status: 'completed' as const, progress: 100, resultUrl: 'data:video/mp4;base64,AAAA' }),
      },
      capabilities: caps,
    }),
  };
  const modelResolver = {
    listVideoCandidates: vi.fn().mockResolvedValue([{ modelId: 'm1', providerId: 'p1', priority: 1, cost: 0, latencyMs: 0 }]),
  };
  const executor = new VideoExecutor(modelResolver as never, videoManager as never, new ModelRouterService(cb, noSleep));
  return { executor, videoManager };
}

describe('VideoExecutor', () => {
  it('成功：submit → 轮询 → 返回文件 + videoSeconds + 归因', async () => {
    const { executor } = makeExecutor();
    const ctx = makeCtx({ prompt: '广告视频', duration: 5 });
    const result = await executor.execute(ctx);
    expect(result.files[0]).toMatchObject({ mimeType: 'video/mp4' });
    expect(result.videoSeconds).toBe(5);
    expect(result.providerId).toBe('p1');
    expect(ctx.setProviderAttempt).toHaveBeenCalledWith('p1', 'm1');
  });

  it('capability 不支持的 duration → UNSUPPORTED_PARAMETER（不静默改写，不回退）', async () => {
    const { executor } = makeExecutor({ supportedDurations: [5], supportedAspectRatios: ['16:9'] });
    const ctx = makeCtx({ prompt: 'x', duration: 10 });
    await expect(executor.execute(ctx)).rejects.toMatchObject({ code: 'UNSUPPORTED_PARAMETER' });
  });

  it('参考图不被支持 → UNSUPPORTED_PARAMETER', async () => {
    const { executor } = makeExecutor({ supportsReferenceImage: false });
    const ctx = makeCtx({ prompt: 'x', referenceImages: ['data:image/png;base64,x'] });
    await expect(executor.execute(ctx)).rejects.toMatchObject({ code: 'UNSUPPORTED_PARAMETER' });
  });

  it('provider 失败 → PROVIDER_UNKNOWN（可重试 → 回退语义由 ModelRouter 处理）', async () => {
    const { executor, videoManager } = makeExecutor();
    videoManager.resolve.mockResolvedValue({
      providerId: 'p1', providerName: 'Mock', modelId: 'm1', apiModelId: 'mock-video-1', timeoutMs: 1000,
      adapter: {
        kind: 'video' as const,
        submit: vi.fn().mockResolvedValue({ remoteTaskId: 'r1' }),
        getStatus: vi.fn().mockResolvedValue({ status: 'failed' as const, error: 'boom' }),
      },
      capabilities: {},
    });
    const ctx = makeCtx({ prompt: 'x' });
    // 轮询首间隔 10s——直接缩短：deadline 已过会抛 MEDIA_TASK_TIMEOUT；这里验证 provider failed 分支用短轮询不可行，
    // 改为直接验证 submit 后 provider failed 的传播：将轮询间隔交给真实等待成本太高，改用 provider 抛错路径
    await expect(executor.execute(ctx)).rejects.toMatchObject({ code: 'PROVIDER_UNKNOWN' });
  }, 20000);
});

describe('Pre-M9 G7：VideoExecutor.queryRemoteStatus（远端恢复查询，不轮询、不重试）', () => {
  const query = (over: Partial<MediaRemoteQuery> = {}): MediaRemoteQuery => ({
    taskId: 't1', remoteTaskId: 'r1', modelId: 'm1', providerId: 'p1', input: { duration: 5 }, deadline: Date.now() + 5_000, ...over,
  });

  it('远端已完成 → completed（结果归因 provider/model/duration 与正常执行一致）', async () => {
    const { executor, videoManager } = makeExecutor();
    await expect(executor.queryRemoteStatus(query())).resolves.toEqual({
      status: 'completed',
      result: {
        files: [{ url: 'data:video/mp4;base64,AAAA', mimeType: 'video/mp4', metadata: { duration: 5 } }],
        imageCount: 0, videoSeconds: 5, providerId: 'p1', modelId: 'm1',
      },
    });
    expect(videoManager.resolve).toHaveBeenCalledWith('m1');
  });

  it('远端完成但无结果 url → failed（绝不产生空附件/假完成）', async () => {
    const { executor, videoManager } = makeExecutor();
    const resolved = await videoManager.resolve('m1');
    (resolved.adapter.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'completed', progress: 100 });
    await expect(executor.queryRemoteStatus(query())).resolves.toEqual({ status: 'failed', error: '视频完成但无结果' });
  });

  it('远端已失败 → failed（文案来自 provider）', async () => {
    const { executor, videoManager } = makeExecutor();
    const resolved = await videoManager.resolve('m1');
    (resolved.adapter.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'failed', error: '平台终止' });
    await expect(executor.queryRemoteStatus(query())).resolves.toEqual({ status: 'failed', error: '平台终止' });
  });

  it('远端仍在执行 → processing（保持非终态，绝不提前判死）', async () => {
    const { executor, videoManager } = makeExecutor();
    const resolved = await videoManager.resolve('m1');
    (resolved.adapter.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'processing', progress: 40 });
    await expect(executor.queryRemoteStatus(query())).resolves.toEqual({ status: 'processing' });
  });

  it('无 modelId（无 provider 归因）→ null 且不解析适配器（调用方按不可恢复兜底）', async () => {
    const { executor, videoManager } = makeExecutor();
    await expect(executor.queryRemoteStatus(query({ modelId: null }))).resolves.toBeNull();
    expect(videoManager.resolve).not.toHaveBeenCalled();
  });
});
