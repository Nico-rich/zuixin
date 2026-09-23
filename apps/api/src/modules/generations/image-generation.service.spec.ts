import { describe, it, expect, vi } from 'vitest';
import { ImageGenerationService } from './image-generation.service';
import { ModelRouterService } from '../../core/model-router/model-router.service';
import { CircuitBreakerService } from '../../core/circuit-breaker/circuit-breaker.service';
import { KVStore } from '../../core/circuit-breaker/kv-store.interface';

const kv: KVStore = { incr: async () => 1, get: async () => null, set: async () => undefined, setNX: async () => true, del: async () => undefined };
const cb = new CircuitBreakerService(kv, () => 0);
const noSleep = async () => undefined;

function makeService() {
  const prisma = {
    systemSetting: { findUnique: vi.fn().mockResolvedValue({ key: 'limits', value: { dailyImage: 50 } }) },
    usageRecord: { count: vi.fn().mockResolvedValue(0) },
    generationTask: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'task-1', ...data })),
      findUnique: vi.fn().mockResolvedValue({
        id: 'task-1', userId: 'u1', conversationId: 'c1', messageId: 'm1',
        type: 'image', status: 'pending', input: { prompt: '主图', count: 1 },
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    attachment: { create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'att-1', ...data })) },
    model: { findUnique: vi.fn().mockResolvedValue({ id: 'm1', unitPrice: 0.04 }) },
  };
  const storage = { put: vi.fn().mockResolvedValue(undefined) };
  const imageManager = {
    resolve: vi.fn().mockResolvedValue({
      providerId: 'p1', providerName: 'Mock', modelId: 'm1', apiModelId: 'mock-image-1', timeoutMs: 1000,
      adapter: { kind: 'image' as const, generate: vi.fn().mockResolvedValue({ images: [{ url: 'data:image/png;base64,AAAA' }], usage: { imageCount: 1, providerModel: 'mock-image-1' } }) },
    }),
  };
  const modelResolver = {
    listImageCandidates: vi.fn().mockResolvedValue([{ modelId: 'm1', providerId: 'p1', priority: 1, cost: 0.04, latencyMs: 0 }]),
  };
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  const usage = { recordImageUsage: vi.fn().mockResolvedValue(undefined) };
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const modelRouter = new ModelRouterService(cb, noSleep);
  const svc = new ImageGenerationService(
    prisma as never, storage as never, modelResolver as never, imageManager as never,
    modelRouter, events as never, usage as never, queue as never,
  );
  return { svc, prisma, storage, usage, queue, events, imageManager };
}

describe('ImageGenerationService.prepareImageTask', () => {
  it('限额内：建 pending 任务 + 入队', async () => {
    const { svc, prisma, queue } = makeService();
    const task = await svc.prepareImageTask({ userId: 'u1', prompt: '主图', count: 2 });
    expect(task.id).toBe('task-1');
    expect(prisma.generationTask.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'pending', type: 'image', input: expect.objectContaining({ count: 2 }) }),
    }));
    expect(queue.add).toHaveBeenCalledWith('generate', { taskId: 'task-1' }, expect.anything());
  });

  it('超出每日限额 → QUOTA_EXCEEDED，不入队', async () => {
    const { svc, prisma, queue } = makeService();
    prisma.usageRecord.count.mockResolvedValue(50);
    await expect(svc.prepareImageTask({ userId: 'u1', prompt: '主图' })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('ImageGenerationService.executeTask', () => {
  it('pending → processing → 转存 attachments → completed + 用量', async () => {
    const { svc, prisma, storage, usage } = makeService();
    await svc.executeTask('task-1');
    expect(prisma.generationTask.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-1' },
      data: expect.objectContaining({ status: 'completed', output: { attachments: ['att-1'] } }),
    }));
    expect(storage.put).toHaveBeenCalled();
    expect(prisma.attachment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'generated_image', taskId: 'task-1' }),
    }));
    expect(usage.recordImageUsage).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', imageCount: 1 }));
  });

  it('非 pending 状态 → 幂等跳过', async () => {
    const { svc, prisma } = makeService();
    prisma.generationTask.findUnique.mockResolvedValue({ id: 'task-1', status: 'completed' });
    await svc.executeTask('task-1');
    expect(prisma.generationTask.update).not.toHaveBeenCalled();
  });

  it('provider 全部失败 → failed + errorCode + 用量失败记录', async () => {
    const { svc, prisma, imageManager, usage } = makeService();
    imageManager.resolve.mockResolvedValue({
      providerId: 'p1', providerName: 'Mock', modelId: 'm1', apiModelId: 'mock-image-1', timeoutMs: 1000,
      adapter: { kind: 'image' as const, generate: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 429 })) },
    });
    await svc.executeTask('task-1');
    expect(prisma.generationTask.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', errorCode: 'PROVIDER_RATE_LIMITED' }),
    }));
    expect(usage.recordImageUsage).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });
});
