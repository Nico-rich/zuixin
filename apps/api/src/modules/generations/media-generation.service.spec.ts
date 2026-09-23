import { describe, it, expect, vi } from 'vitest';
import { MediaGenerationService } from './media-generation.service';
import { MediaExecutor, MediaExecResult } from './media-types';

function makeService(opts: { executorResult?: MediaExecResult; executorError?: Error; pendingTask?: boolean } = {}) {
  const prisma = {
    systemSetting: { findUnique: vi.fn().mockResolvedValue({ key: 'limits', value: { dailyImage: 50, dailyVideo: 10 } }) },
    usageRecord: { count: vi.fn().mockResolvedValue(0) },
    generationTask: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'task-1', ...data })),
      findUnique: vi.fn().mockResolvedValue({
        id: 'task-1', userId: 'u1', conversationId: 'c1', messageId: 'm1',
        type: 'image', status: opts.pendingTask === false ? 'completed' : 'pending',
        input: { prompt: '主图', count: 1 },
        providerId: null, modelId: null, remoteTaskId: null,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    attachment: { create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'att-1', ...data })), deleteMany: vi.fn() },
    model: { findUnique: vi.fn().mockResolvedValue({ id: 'm1', unitPrice: 0.04 }) },
  };
  const storage = { put: vi.fn().mockResolvedValue(undefined) };
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  const usage = { recordMediaUsage: vi.fn().mockResolvedValue(undefined) };
  const imageQueue = { add: vi.fn().mockResolvedValue(undefined) };
  const videoQueue = { add: vi.fn().mockResolvedValue(undefined) };
  const result: MediaExecResult = opts.executorResult ?? {
    files: [{ url: 'data:image/png;base64,AAAA', mimeType: 'image/png' }],
    imageCount: 1, videoSeconds: 0, providerId: 'p1', modelId: 'm1',
  };
  const executor: MediaExecutor = {
    type: 'image',
    execute: opts.executorError ? vi.fn().mockRejectedValue(opts.executorError) : vi.fn().mockResolvedValue(result),
  };
  const executors = new Map([['image', executor]]);
  const svc = new MediaGenerationService(
    prisma as never, storage as never, events as never, usage as never,
    imageQueue as never, videoQueue as never, executors,
  );
  return { svc, prisma, storage, usage, imageQueue, videoQueue, events, executor, executors };
}

describe('MediaGenerationService.prepareMediaTask', () => {
  it('image 任务：限额内建 pending + 入 image 队列', async () => {
    const { svc, prisma, imageQueue } = makeService();
    const task = await svc.prepareImageTask({ userId: 'u1', params: { prompt: '主图', count: 2 } });
    expect(task.id).toBe('task-1');
    expect(prisma.generationTask.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'pending', type: 'image', input: expect.objectContaining({ count: 2 }) }),
    }));
    expect(imageQueue.add).toHaveBeenCalled();
  });

  it('video 任务：入 video 队列（独立队列，不串线）', async () => {
    const { svc, videoQueue, imageQueue } = makeService();
    await svc.prepareVideoTask({ userId: 'u1', params: { prompt: '视频', duration: 5 } });
    expect(videoQueue.add).toHaveBeenCalled();
    expect(imageQueue.add).not.toHaveBeenCalled();
  });

  it('超出每日限额 → QUOTA_EXCEEDED，不入队', async () => {
    const { svc, prisma, imageQueue } = makeService();
    prisma.usageRecord.count.mockResolvedValue(50);
    await expect(svc.prepareImageTask({ userId: 'u1', params: { prompt: 'x' } })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(imageQueue.add).not.toHaveBeenCalled();
  });
});

describe('MediaGenerationService.executeTask（可靠性）', () => {
  it('原子 claim：pending → processing（updateMany 条件更新）', async () => {
    const { svc, prisma } = makeService();
    await svc.executeTask('task-1');
    expect(prisma.generationTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-1', status: 'pending' },
      data: expect.objectContaining({ status: 'processing' }),
    }));
  });

  it('非 pending 状态 → 幂等跳过（重复消费安全）', async () => {
    const { svc, prisma } = makeService({ pendingTask: false });
    await svc.executeTask('task-1');
    expect(prisma.generationTask.updateMany).not.toHaveBeenCalled();
  });

  it('claim 竞争失败（count=0）→ 直接返回', async () => {
    const { svc, prisma } = makeService();
    prisma.generationTask.updateMany.mockResolvedValue({ count: 0 });
    await svc.executeTask('task-1');
    expect(prisma.attachment.create).not.toHaveBeenCalled();
  });

  it('成功：条件完成 + 转存附件 + 用量（含归因）', async () => {
    const { svc, prisma, storage, usage } = makeService();
    await svc.executeTask('task-1');
    expect(prisma.generationTask.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'task-1', status: 'processing' },
      data: expect.objectContaining({ status: 'completed', providerId: 'p1', modelId: 'm1', output: { attachments: ['att-1'] } }),
    }));
    expect(storage.put).toHaveBeenCalled();
    expect(prisma.attachment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'generated_image', taskId: 'task-1' }),
    }));
    expect(usage.recordMediaUsage).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', providerId: 'p1', modelId: 'm1', kind: 'image' }));
  });

  it('完成时已被清扫标 failed（updateMany count=0）→ 放弃完成并回收附件（单任务单结果）', async () => {
    const { svc, prisma, usage } = makeService();
    prisma.generationTask.updateMany.mockImplementation(async ({ data }) =>
      data.status === 'processing' && data.statusMessage === '处理中' ? { count: 1 } : { count: 0 });
    await svc.executeTask('task-1');
    expect(prisma.attachment.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['att-1'] } } });
    expect(usage.recordMediaUsage).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('执行器抛错 → failed + errorCode + usage 失败归因（attempt 时写入的 provider）', async () => {
    const { svc, prisma, usage } = makeService({
      executorError: Object.assign(new Error('limited'), { status: 429 }),
    });
    await svc.executeTask('task-1');
    expect(prisma.generationTask.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', errorCode: 'PROVIDER_RATE_LIMITED' }),
    }));
    expect(usage.recordMediaUsage).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: 'PROVIDER_RATE_LIMITED' }));
  });

  it('未注册的执行器类型 → failed INTERNAL', async () => {
    const { svc, prisma, executors } = makeService();
    executors.delete('image');
    prisma.generationTask.findUnique.mockResolvedValue({
      id: 'task-1', userId: 'u1', conversationId: null, messageId: null,
      type: 'video', status: 'pending', input: {}, providerId: null, modelId: null, remoteTaskId: null,
    });
    await svc.executeTask('task-1');
    expect(prisma.generationTask.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', errorCode: 'INTERNAL' }),
    }));
  });
});
