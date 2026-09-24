import { describe, it, expect, vi } from 'vitest';
import { MediaGenerationService } from './media-generation.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/**
 * M6-A9 验证：媒体失败 usage 必须携带 runId 归因（与成功路径 media-generation.service.ts:167、
 * 清扫路径 media-cleanup.service.ts:48 一致）——失败行才能并入"一次 Run 的成本"。
 */
function makeService() {
  const task = {
    id: 'task-1', userId: 'u1', type: 'image', status: 'pending',
    conversationId: 'c1', messageId: 'm1', providerId: 'p1', modelId: 'md1',
    runId: 'run-1', toolCallId: 'tc-1', startedAt: new Date(),
  };
  const prisma = {
    generationTask: {
      findUnique: vi.fn().mockResolvedValue(task),
      updateMany: vi.fn()
        .mockResolvedValueOnce({ count: 1 })   // 原子 claim：pending→processing
        .mockResolvedValueOnce({ count: 1 }),  // failTask：processing→failed
      update: vi.fn().mockResolvedValue({}),
    },
    attachment: { create: vi.fn(), deleteMany: vi.fn() },
  };
  const storage = { put: vi.fn() };
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  const usage = { recordMediaUsage: vi.fn().mockResolvedValue(undefined) };
  const queue = { add: vi.fn() };
  const failingExecutor = {
    execute: vi.fn().mockRejectedValue(new AppError(ErrorCode.PROVIDER_OVERLOADED, 'provider down')),
  };
  const executors = new Map([['image', failingExecutor]]);
  const svc = new MediaGenerationService(
    prisma as never, storage as never, events as never, usage as never,
    queue as never, queue as never, executors as never,
  );
  return { svc, prisma, usage };
}

describe('MediaGenerationService 失败归因（M6-A9）', () => {
  it('执行失败 → failTask 写 failed usage 且携带 task.runId', async () => {
    const { svc, usage } = makeService();
    await svc.executeTask('task-1');
    expect(usage.recordMediaUsage).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', status: 'failed', errorCode: 'PROVIDER_OVERLOADED',
      runId: 'run-1', // A9 核心断言：失败行 runId 归因
    }));
  });

  it('已被清扫抢先（failTask 条件更新 count=0）→ 不写 usage（终态不覆盖）', async () => {
    const { svc, prisma, usage } = makeService();
    prisma.generationTask.updateMany
      .mockReset()
      .mockResolvedValueOnce({ count: 1 })   // claim 成功
      .mockResolvedValueOnce({ count: 0 });  // failTask 竞争失败
    await svc.executeTask('task-1');
    expect(usage.recordMediaUsage).not.toHaveBeenCalled();
  });
});
