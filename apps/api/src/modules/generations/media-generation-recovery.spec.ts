import { describe, it, expect, vi } from 'vitest';
import { MediaGenerationService } from './media-generation.service';
import { MediaExecutor, MediaRemoteQuery, MediaRemoteStatus } from './media-types';

/**
 * Pre-M9 G7：进程崩溃/重启后**远端任务恢复**——本地已无执行者轮询，只有 provider 是权威。
 * 语义红线：远端终态必须落库（钱花了不能丢结果）；远端 processing/查询失败**绝不伪造终态**。
 */
const completedResult = {
  files: [{ url: 'https://dashscope.aliyuncs.com/a.png', mimeType: 'image/png' }],
  imageCount: 1,
  videoSeconds: 0,
  providerId: 'p1',
  modelId: 'md1',
};

function makeService(opts: {
  task?: Record<string, unknown> | null;
  query?: (q: MediaRemoteQuery) => Promise<MediaRemoteStatus | null>;
  withQuery?: boolean;
  updateCount?: number;
} = {}) {
  const task = opts.task === null ? null : {
    id: 'task-1', userId: 'u1', type: 'image', status: 'processing',
    conversationId: 'c1', messageId: 'm1', providerId: 'p1', modelId: 'md1',
    runId: 'run-1', toolCallId: 'tc-1', remoteTaskId: 'remote-1',
    startedAt: new Date(Date.now() - 10 * 60_000), input: { prompt: 'x' },
    ...(opts.task ?? {}),
  };
  const prisma = {
    generationTask: {
      findUnique: vi.fn().mockResolvedValue(task),
      updateMany: vi.fn().mockResolvedValue({ count: opts.updateCount ?? 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    attachment: { create: vi.fn().mockResolvedValue({ id: 'att-1' }), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    provider: { findUnique: vi.fn().mockResolvedValue({ baseUrl: 'https://dashscope.aliyuncs.com' }) },
  };
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  const usage = { recordMediaUsage: vi.fn().mockResolvedValue(undefined) };
  const quota = { assertQuota: vi.fn(), release: vi.fn().mockResolvedValue(undefined) };
  const resume = { onTaskTerminal: vi.fn().mockResolvedValue(undefined) };
  const query = vi.fn(opts.query ?? (async () => null));
  const executor: MediaExecutor = {
    type: 'image' as never,
    execute: vi.fn(),
    ...(opts.withQuery === false ? {} : { queryRemoteStatus: query }),
  };
  const svc = new MediaGenerationService(
    prisma as never, { put: vi.fn().mockResolvedValue(undefined) } as never, events as never, usage as never,
    { add: vi.fn() } as never, { add: vi.fn() } as never,
    new Map([['image', executor]]) as never, resume as never, quota as never,
    { fetchBuffer: vi.fn(async (url: string) => ({ buffer: Buffer.from('PNG'), url, bytes: 3, redirects: 0 })) } as never,
  );
  return { svc, prisma, usage, quota, resume, events, query };
}

describe('Pre-M9 G7：MediaGenerationService.recoverRemoteGenerationTask', () => {
  it('远端已完成 → 与正常完成一致地落库（附件/usage/事件/resume/配额释放）', async () => {
    const { svc, prisma, usage, quota, resume, events } = makeService({
      query: async () => ({ status: 'completed', result: completedResult }),
    });
    await expect(svc.recoverRemoteGenerationTask('task-1')).resolves.toBe('completed');

    expect(prisma.generationTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-1', status: { in: ['pending', 'processing'] } }, // 恢复路径允许 pending 起点
      data: expect.objectContaining({ status: 'completed', progress: 100, output: { attachments: ['att-1'] } }),
    }));
    expect(usage.recordMediaUsage).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', status: 'success', runId: 'run-1', providerId: 'p1', modelId: 'md1',
    }));
    expect(events.publish).toHaveBeenCalledWith('task', expect.objectContaining({ type: 'task.completed', taskId: 'task-1' }));
    expect(resume.onTaskTerminal).toHaveBeenCalledWith('task-1');
    expect(quota.release).toHaveBeenCalledWith('task-1', 'image_generation');
  });

  it('远端已失败 → 落 failed 且错误文案来自 provider（不谎报成功）', async () => {
    const { svc, prisma, usage, quota } = makeService({
      query: async () => ({ status: 'failed', error: '远端任务被平台终止' }),
    });
    await expect(svc.recoverRemoteGenerationTask('task-1')).resolves.toBe('failed');

    expect(prisma.generationTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-1', status: { in: ['pending', 'processing'] } },
      data: expect.objectContaining({ status: 'failed', errorCode: 'PROVIDER_UNKNOWN', errorMessage: '远端任务被平台终止' }),
    }));
    expect(usage.recordMediaUsage).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', taskId: 'task-1' }));
    expect(quota.release).toHaveBeenCalledWith('task-1', 'image_generation');
  });

  it('远端仍在执行 → 保持非终态（绝不提前判死，交由护栏/超时兜底）', async () => {
    const { svc, prisma, usage } = makeService({ query: async () => ({ status: 'processing' }) });
    await expect(svc.recoverRemoteGenerationTask('task-1')).resolves.toBe('processing');
    expect(prisma.generationTask.updateMany).not.toHaveBeenCalled();
    expect(usage.recordMediaUsage).not.toHaveBeenCalled();
  });

  it('无 remoteTaskId（从未提交远端）→ unknown 且不查询 provider', async () => {
    const { svc, query } = makeService({ task: { remoteTaskId: null } });
    await expect(svc.recoverRemoteGenerationTask('task-1')).resolves.toBe('unknown');
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'cancelled'])('终态行绝不复活（status=%s）', async (status) => {
    const { svc, prisma, query } = makeService({ task: { status } });
    await expect(svc.recoverRemoteGenerationTask('task-1')).resolves.toBe('unknown');
    expect(query).not.toHaveBeenCalled();
    expect(prisma.generationTask.updateMany).not.toHaveBeenCalled();
  });

  it('执行器无 queryRemoteStatus（同步型 provider）→ unknown（不谎报，也不判失败）', async () => {
    const { svc } = makeService({ withQuery: false });
    await expect(svc.recoverRemoteGenerationTask('task-1')).resolves.toBe('unknown');
  });

  it('查询抛错（provider 不可达/模型停用）→ unknown，不写任何终态', async () => {
    const { svc, prisma, usage } = makeService({ query: async () => { throw new Error('provider 不可达'); } });
    await expect(svc.recoverRemoteGenerationTask('task-1')).resolves.toBe('unknown');
    expect(prisma.generationTask.updateMany).not.toHaveBeenCalled();
    expect(usage.recordMediaUsage).not.toHaveBeenCalled();
  });

  it('竞态：恢复写入时已被清扫终态（count=0）→ unknown 并回收已转存附件（不产生孤儿附件）', async () => {
    const { svc, prisma, usage } = makeService({
      query: async () => ({ status: 'completed', result: completedResult }),
      updateCount: 0,
    });
    await expect(svc.recoverRemoteGenerationTask('task-1')).resolves.toBe('unknown');
    expect(prisma.attachment.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['att-1'] } } });
    expect(usage.recordMediaUsage).not.toHaveBeenCalled(); // 未成为事实的完成绝不记账
  });

  it('查询入参携带任务归因与**有界 deadline**（env 可收紧，绝不无限期挂住清扫）', async () => {
    process.env.MEDIA_RECOVERY_QUERY_TIMEOUT_MS = '50';
    try {
      const { svc, query } = makeService({ query: async () => ({ status: 'processing' }) });
      await svc.recoverRemoteGenerationTask('task-1');
      const arg = query.mock.calls[0][0] as MediaRemoteQuery;
      expect(arg).toMatchObject({ taskId: 'task-1', remoteTaskId: 'remote-1', modelId: 'md1', providerId: 'p1', input: { prompt: 'x' } });
      expect(arg.deadline - Date.now()).toBeLessThanOrEqual(50);
    } finally { delete process.env.MEDIA_RECOVERY_QUERY_TIMEOUT_MS; }
  });
});
