import { describe, it, expect, vi } from 'vitest';
import { LIMITS } from '@ai-agent/shared';
import { MediaCleanupService } from './media-cleanup.service';

const NOW = Date.now();
const staleStartedAt = new Date(NOW - 10 * 60_000); // 10 分钟前
const freshStartedAt = new Date(NOW - 30_000);      // 30 秒前

interface GenRow {
  id: string; type: 'image' | 'video'; status: 'pending' | 'processing';
  startedAt: Date | null; createdAt: Date; remoteTaskId?: string | null;
  userId?: string; providerId?: string | null; modelId?: string | null;
  conversationId?: string | null; messageId?: string | null; runId?: string | null;
}

function makeService(opts: {
  staleCount?: number; freshCount?: number; timeoutMs?: number;
  rows?: Array<{ id: string; startedAt: Date; agentId: string; userId: string }>;
  genRows?: GenRow[];
  genUpdateCount?: number;
  recover?: string | (() => Promise<string>);
  externalRecover?: () => Promise<{ scanned: number; recovered: number }>;
} = {}) {
  const prisma = {
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue({ key: 'limits', value: { agentRunTimeoutMs: opts.timeoutMs ?? 120000 } }),
    },
    generationTask: {
      findMany: vi.fn().mockResolvedValue((opts.genRows ?? []).map((r) => ({
        userId: 'u1', providerId: 'p1', modelId: 'm1', conversationId: null, messageId: null, runId: null, remoteTaskId: null, ...r,
      }))),
      updateMany: vi.fn().mockResolvedValue({ count: opts.genUpdateCount ?? 1 }),
    },
    agentRun: {
      findMany: vi.fn().mockResolvedValue(opts.rows ?? [
        { id: 'run-stale', startedAt: staleStartedAt, agentId: 'a1', userId: 'u1' },
        { id: 'run-fresh', startedAt: freshStartedAt, agentId: 'a1', userId: 'u1' },
      ]),
      updateMany: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => ({
        count: where.id === 'run-stale' ? (opts.staleCount ?? 1) : (opts.freshCount ?? 0),
      })),
    },
  };
  const usage = { recordMediaUsage: vi.fn().mockResolvedValue(undefined) };
  const quota = { release: vi.fn().mockResolvedValue(undefined) };
  const resume = { onTaskTerminal: vi.fn().mockResolvedValue(undefined) };
  const recoverFn = typeof opts.recover === 'function' ? opts.recover : async () => (opts.recover ?? 'unknown');
  const media = { recoverRemoteGenerationTask: vi.fn().mockImplementation(recoverFn) };
  const externalActions = {
    recoverStaleExecutingActions: vi.fn().mockImplementation(opts.externalRecover ?? (async () => ({ scanned: 0, recovered: 0 }))),
  };
  const svc = new MediaCleanupService(
    prisma as never, usage as never, quota as never, resume as never, media as never, externalActions as never,
  );
  return { svc, prisma, resume, media, externalActions, quota, usage };
}

describe('MediaCleanupService.sweepAgentRuns（M4 Audit MUST-1）', () => {
  it('stale running run → timeout（条件更新 where status=running）', async () => {
    const { svc, prisma } = makeService();
    const swept = await svc.sweepAgentRuns();
    expect(swept).toBe(1); // 只有 stale 被清扫
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-stale', status: 'running' },
      data: expect.objectContaining({ status: 'timeout', errorCode: 'AGENT_RUN_TIMEOUT' }),
    }));
  });

  it('正常执行中的 run（未超时）不被触碰', async () => {
    const { svc, prisma } = makeService();
    await svc.sweepAgentRuns();
    expect(prisma.agentRun.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'run-fresh' }) }));
  });

  it('已终态 run 不受影响（查询只取 running）', async () => {
    const { svc, prisma } = makeService();
    await svc.sweepAgentRuns();
    expect(prisma.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'running' }) }));
  });

  it('M6-A2：只扫同步 run（workerId IS NULL）——异步 run 由 lease 恢复链路接管，不被 120s 误杀', async () => {
    const { svc, prisma } = makeService();
    await svc.sweepAgentRuns();
    expect(prisma.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'running', workerId: null } }));
  });

  it('并发清扫：条件更新竞态（count=0）→ 不重复计入', async () => {
    const { svc } = makeService({ staleCount: 0 }); // 另一 worker 已抢先清扫
    const swept = await svc.sweepAgentRuns();
    expect(swept).toBe(0);
  });

  it('幂等：第一次清扫后第二次扫不到 running（结果一致）', async () => {
    const { svc, prisma } = makeService({ rows: [{ id: 'run-stale', startedAt: staleStartedAt, agentId: 'a1', userId: 'u1' }] });
    expect(await svc.sweepAgentRuns()).toBe(1);
    prisma.agentRun.findMany.mockResolvedValue([]); // 已终态 → 第二次无 running
    expect(await svc.sweepAgentRuns()).toBe(0);
  });

  it('阈值来自配置（非写死）：agentRunTimeoutMs=10s 时 30s 前的 run 会被清扫', async () => {
    const { svc } = makeService({
      timeoutMs: 10_000, // 阈值 10s → 30s 前的 fresh run 视为 stale
      rows: [{ id: 'run-fresh', startedAt: freshStartedAt, agentId: 'a1', userId: 'u1' }],
      freshCount: 1,
    });
    expect(await svc.sweepAgentRuns()).toBe(1);
  });
});

describe('Pre-M9 G7：GenerationTask 清扫前的远端状态恢复', () => {
  const V = LIMITS.VIDEO_TASK_TIMEOUT_MS;
  const overTimeout = new Date(NOW - V - 60_000);          // 已超任务超时，但仍在 2× 护栏内
  const overGrace = new Date(NOW - V * 2 - 60_000);        // 超过 2× 护栏（远端长期未终态）
  const remoteRow = (over: Date): GenRow => ({
    id: 't-video', type: 'video', status: 'processing', startedAt: over, createdAt: over, remoteTaskId: 'remote-1',
  });

  it('远端已完成 → 按真实结果恢复：清扫侧绝不判超时（不写终态、不重复释放配额/唤醒）', async () => {
    const { svc, prisma, media, quota, usage, externalActions } = makeService({ genRows: [remoteRow(overTimeout)], recover: 'completed' });
    expect(await svc.sweep()).toBe(0); // 恢复为终态 ≠ 被判失败
    expect(media.recoverRemoteGenerationTask).toHaveBeenCalledWith('t-video');
    expect(prisma.generationTask.updateMany).not.toHaveBeenCalled();
    expect(usage.recordMediaUsage).not.toHaveBeenCalled();
    expect(quota.release).not.toHaveBeenCalled(); // 配额释放由恢复路径（媒体域）完成
    // G7 接线不变式：清扫周期同时驱动外部动作域的残留恢复
    expect(externalActions.recoverStaleExecutingActions).toHaveBeenCalledTimes(1);
  });

  it('远端已失败 → 由恢复路径落 failed（清扫同样不重复写）', async () => {
    const { svc, prisma, media } = makeService({ genRows: [remoteRow(overTimeout)], recover: 'failed' });
    expect(await svc.sweep()).toBe(0);
    expect(media.recoverRemoteGenerationTask).toHaveBeenCalledTimes(1);
    expect(prisma.generationTask.updateMany).not.toHaveBeenCalled();
  });

  it('远端仍在执行（护栏内）→ 保持非终态（远端权威，绝不提前判死）', async () => {
    const { svc, prisma } = makeService({ genRows: [remoteRow(overTimeout)], recover: 'processing' });
    expect(await svc.sweep()).toBe(0);
    expect(prisma.generationTask.updateMany).not.toHaveBeenCalled();
  });

  it('远端长期未终态（超 2× 超时护栏）→ 交超时兜底裁决（不永久挂在生成中）', async () => {
    const { svc, prisma, quota, resume } = makeService({ genRows: [remoteRow(overGrace)], recover: 'processing' });
    expect(await svc.sweep()).toBe(1);
    expect(prisma.generationTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 't-video', status: { in: ['processing', 'pending'] } },
      data: expect.objectContaining({ status: 'failed', errorCode: 'MEDIA_TASK_TIMEOUT' }),
    }));
    expect(quota.release).toHaveBeenCalledWith('t-video', 'video_seconds');
    expect(resume.onTaskTerminal).toHaveBeenCalledWith('t-video');
  });

  it('远端查询失败/无适配器（unknown）→ 转入超时兜底，不伪造终态', async () => {
    const { svc, prisma } = makeService({ genRows: [remoteRow(overTimeout)], recover: 'unknown' });
    expect(await svc.sweep()).toBe(1);
    expect(prisma.generationTask.updateMany).toHaveBeenCalledTimes(1);
  });

  it('远端恢复抛错 → 清扫捕获后转入超时兜底（清扫周期绝不因单个任务中断）', async () => {
    const { svc, prisma, externalActions } = makeService({
      genRows: [remoteRow(overTimeout)],
      recover: () => Promise.reject(new Error('provider 不可达')),
    });
    expect(await svc.sweep()).toBe(1);
    expect(prisma.generationTask.updateMany).toHaveBeenCalledTimes(1);
    expect(externalActions.recoverStaleExecutingActions).toHaveBeenCalled();
  });

  it('未超时的 processing 任务：既不查远端也不触碰（不影响正常执行中的任务）', async () => {
    const fresh = new Date(NOW - 30_000);
    const { svc, prisma, media } = makeService({
      genRows: [{ id: 't-live', type: 'image', status: 'processing', startedAt: fresh, createdAt: fresh, remoteTaskId: 'remote-2' }],
    });
    expect(await svc.sweep()).toBe(0);
    expect(media.recoverRemoteGenerationTask).not.toHaveBeenCalled();
    expect(prisma.generationTask.updateMany).not.toHaveBeenCalled();
  });

  it('无 remoteTaskId（同步型/从未提交远端）→ 不做无谓查询，直接超时兜底', async () => {
    const { svc, media, prisma } = makeService({
      genRows: [{ id: 't-sync', type: 'image', status: 'processing', startedAt: new Date(NOW - LIMITS.IMAGE_TASK_TIMEOUT_MS - 60_000), createdAt: new Date(NOW - LIMITS.IMAGE_TASK_TIMEOUT_MS - 60_000) }],
    });
    expect(await svc.sweep()).toBe(1);
    expect(media.recoverRemoteGenerationTask).not.toHaveBeenCalled();
    expect(prisma.generationTask.updateMany).toHaveBeenCalledTimes(1);
  });

  it('pending 陈旧行（投递失败/无人 claim）→ 一并清扫为失败并释放配额（绝不永久挂 pending）', async () => {
    const old = new Date(NOW - LIMITS.IMAGE_TASK_TIMEOUT_MS - 60_000);
    const { svc, prisma, quota, resume, media } = makeService({
      genRows: [{ id: 't-pending', type: 'image', status: 'pending', startedAt: null, createdAt: old }],
    });
    expect(await svc.sweep()).toBe(1);
    expect(media.recoverRemoteGenerationTask).not.toHaveBeenCalled();
    expect(prisma.generationTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 't-pending', status: { in: ['processing', 'pending'] } },
      data: expect.objectContaining({ status: 'failed', errorCode: 'MEDIA_TASK_TIMEOUT' }),
    }));
    expect(quota.release).toHaveBeenCalledWith('t-pending', 'image_generation');
    expect(resume.onTaskTerminal).toHaveBeenCalledWith('t-pending');
  });

  it('pending 新鲜行（刚创建）→ 不触碰', async () => {
    const { svc, prisma } = makeService({
      genRows: [{ id: 't-new', type: 'image', status: 'pending', startedAt: null, createdAt: new Date(NOW - 1_000) }],
    });
    expect(await svc.sweep()).toBe(0);
    expect(prisma.generationTask.updateMany).not.toHaveBeenCalled();
  });

  it('并发/多 Worker：终态写入竞态（count=0）不计入清扫数', async () => {
    const { svc } = makeService({
      genRows: [{ id: 't-race', type: 'image', status: 'processing', startedAt: new Date(NOW - LIMITS.IMAGE_TASK_TIMEOUT_MS - 60_000), createdAt: new Date(NOW - LIMITS.IMAGE_TASK_TIMEOUT_MS - 60_000) }],
      genUpdateCount: 0, // 另一 Worker 已抢先终态
    });
    expect(await svc.sweep()).toBe(0);
  });

  it('外部动作恢复失败绝不打断媒体清扫（同周期不同域，故障隔离）', async () => {
    const { svc } = makeService({
      genRows: [{ id: 't-img', type: 'image', status: 'processing', startedAt: new Date(NOW - LIMITS.IMAGE_TASK_TIMEOUT_MS - 60_000), createdAt: new Date(NOW - LIMITS.IMAGE_TASK_TIMEOUT_MS - 60_000) }],
      externalRecover: () => Promise.reject(new Error('外部动作域异常')),
    });
    expect(await svc.sweep()).toBe(1); // 媒体清扫结果不受影响
  });
});
