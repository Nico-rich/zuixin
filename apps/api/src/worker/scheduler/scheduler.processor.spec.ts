import { describe, it, expect, vi } from 'vitest';
import { Job } from 'bullmq';
import type { ScheduledJob } from '@prisma/client';
import { SchedulerProcessor } from './scheduler.processor';

/**
 * M8-P9 Scheduler 可靠性单测（心跳 + stalled 巡检 + 优雅停机等待在途）。
 * 依赖全部为替身：**不真跑队列、不真崩溃进程**；真实的队列/DB 行为由 m8-p9 e2e 覆盖。
 */

function jobRow(over: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'job-1', organizationId: null, ownerUserId: 'u1', name: 'n', type: 'one-shot',
    cron: null, runAt: null, status: 'running', priority: 0, timeoutMs: 60_000, maxAttempts: 3,
    backoffMs: 2_000, payload: null, handler: 'noop', idempotencyKey: null, traceId: null,
    lastError: null, attempts: 1, scheduledAt: null, completedAt: null,
    createdAt: new Date(), updatedAt: new Date(Date.now() - 10 * 60_000), // 10min 无心跳
    ...over,
  } as ScheduledJob;
}

function makeProcessor(rows: ScheduledJob[]) {
  const prisma = {
    scheduledJob: {
      findMany: vi.fn().mockResolvedValue(rows),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const handlers = new Map<string, () => Promise<void> | void>();
  const scheduler = {
    getHandler: vi.fn((name: string) => handlers.get(name)),
    enqueueRetry: vi.fn().mockResolvedValue(undefined),
  };
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  const proc = new SchedulerProcessor(scheduler as never, prisma as never, events as never);
  return { proc, prisma, scheduler, events, handlers };
}

describe('M8-P9 Scheduler stalled 巡检（一致性优先：判 dead，绝不自动重投）', () => {
  it('running 且心跳中断超阈值 → 判 dead + lastError 留痕 + 事件落库，且**不重投**', async () => {
    const { proc, prisma, scheduler, events } = makeProcessor([jobRow()]);
    const res = await proc.reconcileStalled();

    expect(res).toEqual({ reaped: 1, scanned: 1 });
    const arg = prisma.scheduledJob.updateMany.mock.calls[0][0] as { where: { status: string }; data: { status: string; lastError: string } };
    expect(arg.where).toMatchObject({ id: 'job-1', status: 'running' }); // 条件更新：与正常完成竞争由 DB 裁决
    expect(arg.data.status).toBe('dead');
    expect(arg.data.lastError).toContain('stalled');
    expect(arg.data.lastError).toContain('不自动重投');
    expect(scheduler.enqueueRetry).not.toHaveBeenCalled(); // 一致性优先：绝不自动重投
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.job.dead' }));
  });

  it('阈值 = max(timeoutMs × 3, 3 × 心跳)：60s 作业 30s 无心跳仍不判死（避免误杀长作业）', async () => {
    const { proc } = makeProcessor([jobRow({ timeoutMs: 60_000, updatedAt: new Date(Date.now() - 30_000) })]);
    expect(await proc.reconcileStalled()).toEqual({ reaped: 0, scanned: 1 });
  });

  it('心跳新鲜 → 不动（巡检绝不误杀正在执行的作业）', async () => {
    const { proc, prisma } = makeProcessor([jobRow({ timeoutMs: 5_000, updatedAt: new Date() })]);
    expect(await proc.reconcileStalled()).toEqual({ reaped: 0, scanned: 1 });
    expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled();
  });

  it('条件更新 count=0（已被其他 worker 判死/已完成）→ 不计入 reaped、不发事件（幂等）', async () => {
    const { proc, prisma, events } = makeProcessor([jobRow()]);
    prisma.scheduledJob.updateMany.mockResolvedValue({ count: 0 });
    expect(await proc.reconcileStalled()).toEqual({ reaped: 0, scanned: 1 });
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('无 running 行 → 空扫描（不产生任何写操作）', async () => {
    const { proc, prisma } = makeProcessor([]);
    expect(await proc.reconcileStalled()).toEqual({ reaped: 0, scanned: 0 });
    expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled();
  });
});

describe('M8-P9 Scheduler 心跳（执行期间刷新 updatedAt）', () => {
  it('process()：执行期间按 timeoutMs/3（钳制 500ms~5s）刷新 updatedAt，结束后停止心跳', async () => {
    const { proc, prisma, handlers } = makeProcessor([]);
    const row = jobRow({ id: 'job-hb', timeoutMs: 1_500, status: 'scheduled', attempts: 0 });
    prisma.scheduledJob.findUnique.mockResolvedValue(row);
    let handlerDone = false;
    handlers.set('noop', async () => { await new Promise((r) => setTimeout(r, 700)); handlerDone = true; });

    const job = { data: { jobId: 'job-hb' } } as Job<{ jobId?: string }>;
    await proc.process(job);
    expect(handlerDone).toBe(true);

    // 心跳写：where 带 status:'running'（作业被取消/重投后绝不再续写），data.updatedAt 为当前时间
    const heartbeats = prisma.scheduledJob.updateMany.mock.calls
      .map((c) => c[0] as { where: Record<string, unknown>; data: Record<string, unknown> })
      .filter((a) => a.data && 'updatedAt' in a.data);
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(heartbeats[0].where).toMatchObject({ id: 'job-hb', status: 'running' });
    expect(heartbeats[0].data.updatedAt).toBeInstanceOf(Date);

    // 结束后不再有新心跳（clearInterval 生效）
    const after = prisma.scheduledJob.updateMany.mock.calls.length;
    await new Promise((r) => setTimeout(r, 700));
    expect(prisma.scheduledJob.updateMany.mock.calls.length).toBe(after);
  }, 20_000);

  it('process()：进程停机中不认领新作业（BullMQ 会在关闭后重新投递）', async () => {
    const { proc, prisma, handlers } = makeProcessor([]);
    prisma.scheduledJob.findUnique.mockResolvedValue(jobRow({ status: 'scheduled' }));
    handlers.set('noop', vi.fn());
    (proc as unknown as { shuttingDown: boolean }).shuttingDown = true;
    await proc.process({ data: { jobId: 'job-1' } } as Job<{ jobId?: string }>);
    expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled(); // 未认领
  });
});

describe('M8-P9 Scheduler 优雅停机（等在途收尾，有界）', () => {
  it('onApplicationShutdown：等在途作业跑完才返回（不半途丢弃）', async () => {
    const prev = process.env.SCHEDULER_SHUTDOWN_WAIT_MS;
    process.env.SCHEDULER_SHUTDOWN_WAIT_MS = '5000';
    try {
      const { proc, prisma, handlers } = makeProcessor([]);
      prisma.scheduledJob.findUnique.mockResolvedValue(jobRow({ id: 'job-wait', status: 'scheduled', attempts: 0 }));
      let finished = false;
      handlers.set('noop', async () => { await new Promise((r) => setTimeout(r, 600)); finished = true; });

      const running = proc.process({ data: { jobId: 'job-wait' } } as Job<{ jobId?: string }>);
      await new Promise((r) => setTimeout(r, 150)); // 确保作业已在途
      await proc.onApplicationShutdown();
      expect(finished).toBe(true); // 停机返回时在途作业已收尾
      expect((proc as unknown as { shuttingDown: boolean }).shuttingDown).toBe(true);
      await running;
    } finally {
      if (prev === undefined) delete process.env.SCHEDULER_SHUTDOWN_WAIT_MS;
      else process.env.SCHEDULER_SHUTDOWN_WAIT_MS = prev;
    }
  }, 20_000);

  it('onApplicationShutdown：等待窗口到期仍在途 → 记录告警后放行（绝不无限等待）', async () => {
    const prev = process.env.SCHEDULER_SHUTDOWN_WAIT_MS;
    process.env.SCHEDULER_SHUTDOWN_WAIT_MS = '200';
    try {
      const { proc, prisma, handlers } = makeProcessor([]);
      prisma.scheduledJob.findUnique.mockResolvedValue(jobRow({ id: 'job-stuck', status: 'scheduled', attempts: 0 }));
      handlers.set('noop', () => new Promise(() => undefined)); // 永不返回（模拟挂住的 handler）
      void proc.process({ data: { jobId: 'job-stuck' } } as Job<{ jobId?: string }>);
      await new Promise((r) => setTimeout(r, 100));

      const t0 = Date.now();
      await proc.onApplicationShutdown();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(2_000); // 有界
    } finally {
      if (prev === undefined) delete process.env.SCHEDULER_SHUTDOWN_WAIT_MS;
      else process.env.SCHEDULER_SHUTDOWN_WAIT_MS = prev;
    }
  }, 20_000);
});
