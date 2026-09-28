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

/**
 * M11-P7 D2-13：巡检改为「select 收窄 + 下推 + take 分页」。
 * 替身忠实实现 where/take/cursor（否则下推/paging 语义在单测里不可见）。
 */
function reconcileQuery(rows: ScheduledJob[], args: Record<string, any>): ScheduledJob[] {
  const cutoff = args.where?.updatedAt?.lt as Date | undefined;
  const status = args.where?.status as string | undefined;
  const matched = rows
    .filter((r) => (!status || r.status === status) && (!cutoff || r.updatedAt.getTime() < cutoff.getTime()))
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id));
  const cursorId = (args.cursor as { id: string } | undefined)?.id;
  const from = cursorId ? matched.findIndex((r) => r.id === cursorId) + 1 : 0;
  const paged = matched.slice(from < 0 ? 0 : from);
  return typeof args.take === 'number' ? paged.slice(0, args.take) : paged;
}

function makeProcessor(rows: ScheduledJob[]) {
  const prisma = {
    scheduledJob: {
      findMany: vi.fn(async (args: Record<string, any>) => reconcileQuery(rows, args)),
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

  it('心跳新鲜 → 不动（巡检绝不误杀正在执行的作业；D2-13 下推后连载入都不发生）', async () => {
    const { proc, prisma } = makeProcessor([jobRow({ timeoutMs: 5_000, updatedAt: new Date() })]);
    // 心跳新鲜（lag < 全局下界 3×HEARTBEAT_MIN_MS）在 SQL 侧即被裁剪 → scanned=0
    expect(await proc.reconcileStalled()).toEqual({ reaped: 0, scanned: 0 });
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

/**
 * M11-P7 D2-13：无界载入治理。
 * 契约：① select 收窄（不载入 payload/cron 等大字段）；② 心跳下推 SQL（全局下界 3×HEARTBEAT_MIN_MS）；
 *      ③ take 上限 + 游标分页（不再一次载入全部 running 行）；④ 单周期批数有界（绝不无限循环）。
 */
describe('M11-P7 D2-13：stalled 巡检下推 + 分页（无界载入治理）', () => {
  it('查询形态：select 收窄 + updatedAt 下推 + take 上限 + (updatedAt,id) 稳定排序', async () => {
    const { proc, prisma } = makeProcessor([]);
    await proc.reconcileStalled();
    const args = prisma.scheduledJob.findMany.mock.calls[0][0] as Record<string, any>;
    expect(args.where).toMatchObject({ status: 'running', updatedAt: { lt: expect.any(Date) } });
    expect(args.take).toBe(200);
    expect(args.orderBy).toEqual([{ updatedAt: 'asc' }, { id: 'asc' }]);
    // 下推界 = 全局下界（阈值对 timeoutMs 单调不减 ⇒ 任何 timeoutMs 的阈值都 ≥ 1500ms）
    expect(Date.now() - (args.where.updatedAt.lt as Date).getTime()).toBeGreaterThanOrEqual(1400);
    // select 收窄：绝不载入 payload/cron/runAt/lastError 等大字段
    expect(Object.keys(args.select).sort()).toEqual(['attempts', 'handler', 'id', 'organizationId', 'ownerUserId', 'timeoutMs', 'type', 'updatedAt']);
  });

  it('分页：超过单批上限的 stalled 行分多批处理（游标推进、绝不漏行/重复行）', async () => {
    const staleAt = new Date(Date.now() - 10 * 60_000);
    const rows = Array.from({ length: 250 }, (_, i) => jobRow({ id: `job-${String(i).padStart(3, '0')}`, updatedAt: staleAt }));
    const { proc, prisma } = makeProcessor(rows);
    const res = await proc.reconcileStalled();
    expect(res).toEqual({ reaped: 250, scanned: 250 }); // 分页绝不漏行
    const args = prisma.scheduledJob.findMany.mock.calls.map((c) => c[0] as Record<string, any>);
    expect(args).toHaveLength(2); // 200 + 50
    expect(args[0].cursor).toBeUndefined();
    expect(args[1].cursor).toEqual({ id: 'job-199' }); // 游标 = 上一批最后一行
    expect(args[1].skip).toBe(1);
    expect(prisma.scheduledJob.updateMany).toHaveBeenCalledTimes(250);
  });

  it('单周期批数有界：数据面持续满批时也绝不无限循环（达到上限即交由下个周期）', async () => {
    let call = 0;
    const { proc, prisma } = makeProcessor([]);
    prisma.scheduledJob.findMany.mockImplementation(async () => {
      call++;
      return Array.from({ length: 200 }, (_, i) => jobRow({ id: `job-${call}-${String(i).padStart(3, '0')}`, updatedAt: new Date(Date.now() - 10 * 60_000) }));
    });
    await proc.reconcileStalled();
    expect(call).toBe(10); // RECONCILE_MAX_BATCHES=10 后停止
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
