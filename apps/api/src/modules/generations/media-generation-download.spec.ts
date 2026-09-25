import { describe, it, expect, vi } from 'vitest';
import { MediaGenerationService } from './media-generation.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/**
 * Pre-M9 F3-A 集成断言：媒体结果下载必须经 SafeRemoteFetcher，**且失败的下载绝不产生可信 Attachment**。
 * - SSRF 命中的结果 URL → 任务以 SSRF_BLOCKED 失败、storage 无写入、Attachment 零行；
 * - 正常路径 → 白名单来自 provider.baseUrl 主机 + 环境变量，附件只在下载成功后才落库。
 */
function makeService(fetchBuffer: (url: string, opts?: unknown) => Promise<{ buffer: Buffer; url: string; bytes: number; redirects: number }>) {
  const task = {
    id: 'task-1', userId: 'u1', type: 'image', status: 'pending',
    conversationId: 'c1', messageId: 'm1', providerId: 'p1', modelId: 'md1',
    runId: null, toolCallId: null, startedAt: new Date(),
  };
  const prisma = {
    generationTask: {
      findUnique: vi.fn().mockResolvedValue(task),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    attachment: { create: vi.fn().mockResolvedValue({ id: 'att-1' }), deleteMany: vi.fn() },
    provider: { findUnique: vi.fn().mockResolvedValue({ baseUrl: 'https://dashscope.aliyuncs.com' }) },
  };
  const storage = { put: vi.fn().mockResolvedValue(undefined) };
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  const usage = { recordMediaUsage: vi.fn().mockResolvedValue(undefined) };
  const executor = {
    execute: vi.fn().mockResolvedValue({
      providerId: 'p1', modelId: 'md1', imageCount: 1, videoSeconds: 0, latencyMs: 5,
      files: [{ url: 'https://evil.example.com/leak.png', mimeType: 'image/png' }],
    }),
  };
  const svc = new MediaGenerationService(
    prisma as never, storage as never, events as never, usage as never,
    { add: vi.fn() } as never, { add: vi.fn() } as never,
    new Map([['image', executor]]) as never,
    { onTaskTerminal: vi.fn().mockResolvedValue(undefined) } as never,
    { assertQuota: vi.fn(), release: vi.fn().mockResolvedValue(undefined) } as never,
    { fetchBuffer: vi.fn(fetchBuffer) } as never,
  );
  return { svc, prisma, storage, usage };
}

describe('Pre-M9 F3-A 媒体下载经 SafeRemoteFetcher', () => {
  it('SSRF_BLOCKED（下载被拒）→ 任务失败归因 SSRF_BLOCKED，且不写 storage/Attachment', async () => {
    const { svc, prisma, storage, usage } = makeService(async () => {
      throw new AppError(ErrorCode.SSRF_BLOCKED, '下载目标未通过安全校验: 不得指向私网地址');
    });
    await svc.executeTask('task-1');

    expect(usage.recordMediaUsage).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', status: 'failed', errorCode: 'SSRF_BLOCKED',
    }));
    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.attachment.create).not.toHaveBeenCalled();
    // 失败终态写入 errorCode（不再被吞成 PROVIDER_UNKNOWN）
    expect(prisma.generationTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', errorCode: 'SSRF_BLOCKED' }),
    }));
  });

  it('合法下载 → 附件落库，且下载时携带 provider 域名白名单与用途标签', async () => {
    const seen: Array<{ url: string; opts?: unknown }> = [];
    const { svc, prisma, storage } = makeService(async (url, opts) => {
      seen.push({ url, opts });
      return { buffer: Buffer.from('PNG'), url, bytes: 3, redirects: 0 };
    });
    await svc.executeTask('task-1');

    expect(prisma.attachment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'generated_image', sizeBytes: 3, taskId: 'task-1' }),
    }));
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].opts).toMatchObject({
      allowedHosts: ['dashscope.aliyuncs.com'], // provider.baseUrl 主机进入白名单（另有环境变量白名单）
      purpose: 'media-download:task-1',
    });
  });

  it('安全策略类失败不重试（避免把 SSRF 命中放大成 3 次出网尝试）', async () => {
    let calls = 0;
    const { svc } = makeService(async () => { calls += 1; throw new AppError(ErrorCode.SSRF_BLOCKED, 'blocked'); });
    await svc.executeTask('task-1');
    expect(calls).toBe(1);
  });
});
