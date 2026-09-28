import { describe, it, expect, vi } from 'vitest';
import { MediaGenerationService } from './media-generation.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/**
 * M6-A9 验证：媒体失败 usage 必须携带 runId 归因（与成功路径 media-generation.service.ts:167、
 * 清扫路径 media-cleanup.service.ts:48 一致）——失败行才能并入"一次 Run 的成本"。
 */
function makeService(opts: { executorError?: AppError; registerExecutor?: boolean } = {}) {
  const task = {
    id: 'task-1', userId: 'u1', type: 'image', status: 'pending',
    conversationId: 'c1', messageId: 'm1', providerId: 'p1', modelId: 'md1',
    runId: 'run-1', toolCallId: 'tc-1', startedAt: new Date(),
    remoteTaskId: null as string | null, // M11-P4：provider 触达事实（null = 未提交过远端任务）
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
    execute: vi.fn().mockRejectedValue(opts.executorError ?? new AppError(ErrorCode.PROVIDER_OVERLOADED, 'provider down')),
  };
  const executors = new Map(opts.registerExecutor === false ? [] : [['image', failingExecutor]]);
  const resume = { onTaskTerminal: vi.fn().mockResolvedValue(undefined) };
  const quota = { assertQuota: vi.fn().mockResolvedValue({ organizationId: 'org-1', reservationId: 'r' }), release: vi.fn().mockResolvedValue(undefined) };
  const svc = new MediaGenerationService(
    prisma as never, storage as never, events as never, usage as never,
    queue as never, queue as never, executors as never, resume as never,
    quota as never);
  return { svc, prisma, usage, resume, quota };
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

/**
 * M11-P4（维度2#12）：**从未触达 provider 的预检失败不虚计**。
 * 旧口径：failTask 恒记 usage(imageCount:0/videoSeconds:0)，账本镜像 Math.max(units,1) 放大成 1 单位
 * → 参数预检拒绝/执行器未注册（provider 侧零消耗）也扣 1 单位 = 虚假计费。
 * 新口径：这类失败不写 usage（无 UsageRecord 事实 → 无账本镜像行）；任务终态/事件/唤醒/配额释放照旧。
 */
describe('MediaGenerationService M11-P4（预检失败不虚计 1 单位）', () => {
  it('执行器未注册（服务端配置缺陷，从未触达 provider）→ 不写 usage 且 quota 预留仍释放', async () => {
    const { svc, usage, quota, resume } = makeService({ registerExecutor: false });
    await svc.executeTask('task-1');
    expect(usage.recordMediaUsage).not.toHaveBeenCalled(); // 0 单位：不产生账本镜像行
    expect(quota.release).toHaveBeenCalledWith('task-1', 'image_generation'); // 预留仍释放（不泄漏）
    expect(resume.onTaskTerminal).toHaveBeenCalledWith('task-1');               // waiting run 仍被唤醒
  });

  it('UNSUPPORTED_PARAMETER（参数能力预检在 HTTP 之前抛出）→ 不写 usage', async () => {
    const { svc, usage } = makeService({
      executorError: new AppError(ErrorCode.UNSUPPORTED_PARAMETER, '时长 7s 不被当前模型支持（支持: 5, 10）'),
    });
    await svc.executeTask('task-1');
    expect(usage.recordMediaUsage).not.toHaveBeenCalled();
  });

  it('已触达 provider 的失败（remoteTaskId 非空）→ 照记（可证明占用过 provider 资源，绝不漏计）', async () => {
    const { svc, prisma, usage } = makeService({
      executorError: new AppError(ErrorCode.UNSUPPORTED_PARAMETER, '远端已提交后失败（防御性用例）'),
    });
    (await prisma.generationTask.findUnique()).remoteTaskId = 'remote-1'; // 已提交远端任务 → 触达事实成立
    await svc.executeTask('task-1');
    expect(usage.recordMediaUsage).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', taskId: 'task-1' }));
  });
});
