import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EventArchiveService, EVENT_ARCHIVE_HANDLER, EVENT_ARCHIVE_CRON, EVENT_ARCHIVE_IDEMPOTENCY_KEY,
  DEFAULT_EVENT_RETENTION_MS,
} from './event-archive.service';
import type { JobHandler, JobHandlerContext } from '../scheduler/scheduler.service';

/** 归档单测：不触 DB/队列——prisma 与 scheduler 均为替身；断言"条件更新 + 批量 + 幂等 + 启动不阻塞"契约 */

function makeService(prismaOverrides: Record<string, unknown> = {}, scheduleResult?: unknown) {
  const prisma = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'admin-1' }) },
    eventEnvelope: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    ...prismaOverrides,
  };
  const handlers = new Map<string, JobHandler>();
  const scheduler = {
    registerHandler: vi.fn((name: string, fn: JobHandler) => { handlers.set(name, fn); }),
    schedule: vi.fn(scheduleResult
      ? vi.fn().mockResolvedValue(scheduleResult)
      : vi.fn().mockResolvedValue({ job: { id: 'sched-1', status: 'scheduled' }, created: true })),
    getHandler: (name: string) => handlers.get(name),
    listHandlers: () => [...handlers.keys()],
  };
  const svc = new EventArchiveService(prisma as never, scheduler as never);
  return { svc, prisma, scheduler, handlers };
}

/** 行替身（只用到 id） */
const rows = (n: number, prefix = 'ev') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));

describe('EventArchiveService（M9-11 归档：published → consumed，条件更新 + 批量 + 幂等）', () => {
  const prevRetention = process.env.EVENT_ENVELOPE_RETENTION_MS;
  beforeEach(() => { vi.clearAllMocks(); delete process.env.EVENT_ENVELOPE_RETENTION_MS; });
  afterEach(() => {
    if (prevRetention === undefined) delete process.env.EVENT_ENVELOPE_RETENTION_MS;
    else process.env.EVENT_ENVELOPE_RETENTION_MS = prevRetention;
    delete process.env.eventEnvelopeRetentionMs;
  });

  it('无候选 → 零副作用（不 UPDATE、不空转批次）', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.archiveExpired()).resolves.toMatchObject({ scanned: 0, archived: 0, batches: 0 });
    expect(prisma.eventEnvelope.updateMany).not.toHaveBeenCalled();
  });

  it('候选查询口径：status=published + occurredAt < now-retention + 最旧优先 + 限量（走 [status, occurredAt] 索引）', async () => {
    const { svc, prisma } = makeService();
    prisma.eventEnvelope.findMany.mockResolvedValue(rows(3));
    prisma.eventEnvelope.updateMany.mockResolvedValue({ count: 3 });
    const now = new Date('2026-09-28T00:00:00.000Z');
    const res = await svc.archiveExpired({ now });
    expect(res).toMatchObject({ scanned: 3, archived: 3, batches: 1, retentionMs: DEFAULT_EVENT_RETENTION_MS });
    const where = prisma.eventEnvelope.findMany.mock.calls[0][0];
    expect(where.where.status).toBe('published'); // failed/dead（死信）绝不被归档掩盖
    expect(where.where.occurredAt.lt).toEqual(new Date(now.getTime() - DEFAULT_EVENT_RETENTION_MS));
    expect(where.orderBy).toEqual({ occurredAt: 'asc' });
    expect(where.take).toBe(500);
    expect(where.select).toEqual({ id: true });
  });

  it('条件更新：WHERE 必须含 status=published（并发/重复执行的唯一赢家语义），写入 consumed + consumedAt', async () => {
    const { svc, prisma } = makeService();
    prisma.eventEnvelope.findMany.mockResolvedValue(rows(2));
    prisma.eventEnvelope.updateMany.mockResolvedValue({ count: 2 });
    await svc.archiveExpired({ now: new Date() });
    const upd = prisma.eventEnvelope.updateMany.mock.calls[0][0];
    expect(upd.where.status).toBe('published');
    expect(upd.where.id).toEqual({ in: ['ev-0', 'ev-1'] });
    expect(upd.data).toMatchObject({ status: 'consumed', lastError: null });
    expect(upd.data.consumedAt).toBeInstanceOf(Date);
  });

  it('幂等：重复执行 → 已 consumed 的行不再是候选（第二次零归档）', async () => {
    const { svc, prisma } = makeService();
    prisma.eventEnvelope.findMany.mockResolvedValueOnce(rows(2)).mockResolvedValueOnce([]);
    prisma.eventEnvelope.updateMany.mockResolvedValueOnce({ count: 2 });
    await expect(svc.archiveExpired()).resolves.toMatchObject({ archived: 2 });
    await expect(svc.archiveExpired()).resolves.toMatchObject({ archived: 0, batches: 0 });
    expect(prisma.eventEnvelope.updateMany).toHaveBeenCalledTimes(1);
  });

  it('并发竞争：另一进程抢先消费（updateMany count=0）→ 本次归档数如实为 0，绝不虚报', async () => {
    const { svc, prisma } = makeService();
    prisma.eventEnvelope.findMany.mockResolvedValueOnce(rows(2)).mockResolvedValueOnce([]);
    prisma.eventEnvelope.updateMany.mockResolvedValueOnce({ count: 0 }); // 输给并发赢家
    await expect(svc.archiveExpired()).resolves.toMatchObject({ scanned: 2, archived: 0 });
  });

  it('批量：满批继续、不满批结束（候选扫尽即停，绝不多打一次空查询）', async () => {
    const { svc, prisma } = makeService();
    prisma.eventEnvelope.findMany
      .mockResolvedValueOnce(rows(2, 'a')) // 满批（batchSize=2）
      .mockResolvedValueOnce(rows(1, 'b')); // 不满批 → 结束
    prisma.eventEnvelope.updateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });
    const res = await svc.archiveExpired({ batchSize: 2, now: new Date() });
    expect(res).toMatchObject({ scanned: 3, archived: 3, batches: 2 });
    expect(prisma.eventEnvelope.findMany).toHaveBeenCalledTimes(2);
  });

  it('单次执行有界：候选超过 maxBatches×batchSize 时只处理上限内的量（剩余留给下个周期）', async () => {
    const { svc, prisma } = makeService();
    prisma.eventEnvelope.findMany.mockResolvedValue(rows(2)); // 永远满批（模拟海量存量）
    prisma.eventEnvelope.updateMany.mockResolvedValue({ count: 2 });
    const res = await svc.archiveExpired({ batchSize: 2, maxBatches: 3, now: new Date() });
    expect(res).toMatchObject({ scanned: 6, archived: 6, batches: 3 }); // 恰好 3 批 × 2 行，绝不无界循环
    expect(prisma.eventEnvelope.findMany).toHaveBeenCalledTimes(3);
  });

  it('保留窗口：env EVENT_ENVELOPE_RETENTION_MS 可覆盖；非法值回落默认 7 天', async () => {
    const { svc, prisma } = makeService();
    process.env.EVENT_ENVELOPE_RETENTION_MS = '3600000'; // 1h
    const now = new Date('2026-09-28T12:00:00.000Z');
    await expect(svc.archiveExpired({ now })).resolves.toMatchObject({ retentionMs: 3_600_000 });
    expect(prisma.eventEnvelope.findMany.mock.calls[0][0].where.occurredAt.lt)
      .toEqual(new Date(now.getTime() - 3_600_000));

    process.env.EVENT_ENVELOPE_RETENTION_MS = '0'; // 0/负数绝不静默关闭归档 → 默认
    await expect(svc.archiveExpired()).resolves.toMatchObject({ retentionMs: DEFAULT_EVENT_RETENTION_MS });
  });

  it('运维/测试 payload 可覆盖保留窗口（周期作业不写 payload → 按 env 生效）', async () => {
    const { svc, prisma } = makeService();
    const now = new Date('2026-09-28T12:00:00.000Z');
    await expect(svc.archiveExpired({ retentionMs: 60_000, now })).resolves.toMatchObject({ retentionMs: 60_000 });
    expect(prisma.eventEnvelope.findMany.mock.calls[0][0].where.occurredAt.lt)
      .toEqual(new Date(now.getTime() - 60_000));
  });
});

describe('EventArchiveService 启动接线（handler 注册 + 周期作业开通，绝不阻塞启动）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('onModuleInit：注册 handler=events.archive；开通 recurring 周期作业（幂等键 + cron + 平台 admin 归属）', async () => {
    const { svc, scheduler } = makeService();
    await svc.onModuleInit();
    expect(scheduler.registerHandler).toHaveBeenCalledWith(EVENT_ARCHIVE_HANDLER, expect.any(Function));
    expect(scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({
      handler: EVENT_ARCHIVE_HANDLER, type: 'recurring', cron: EVENT_ARCHIVE_CRON,
      idempotencyKey: EVENT_ARCHIVE_IDEMPOTENCY_KEY, ownerUserId: 'admin-1', organizationId: null,
    }));
  });

  it('handler 真实可执行：payload 作为覆盖项传入归档（周期触发 → 归档生效）', async () => {
    const { svc, prisma, scheduler } = makeService();
    await svc.onModuleInit();
    prisma.eventEnvelope.findMany.mockResolvedValueOnce(rows(1)).mockResolvedValue([]);
    prisma.eventEnvelope.updateMany.mockResolvedValue({ count: 1 });
    const handler = scheduler.getHandler(EVENT_ARCHIVE_HANDLER)!;
    await handler({ jobId: 'j', name: 'n', handler: EVENT_ARCHIVE_HANDLER, attempt: 1, payload: { batchSize: 1 }, organizationId: null, traceId: null } as JobHandlerContext);
    expect(prisma.eventEnvelope.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.eventEnvelope.findMany.mock.calls[0][0].take).toBe(1);
  });

  it('无 admin 用户（未初始化的库）→ 不开通、不抛错（启动照常）', async () => {
    const { svc, scheduler } = makeService({ user: { findFirst: vi.fn().mockResolvedValue(null) } });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(scheduler.registerHandler).toHaveBeenCalled(); // handler 仍注册（手工作业可执行）
  });

  it('开通失败（DB/Redis 不可达）→ 只告警，绝不让事件归档阻断进程启动', async () => {
    const { svc, scheduler } = makeService({}, null);
    scheduler.schedule.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });

  it('幂等命中（已存在）→ 不重复开通；非活跃态（paused/dead）→ 绝不自动复活（只告警）', async () => {
    const { svc, scheduler } = makeService({}, { job: { id: 'sched-1', status: 'paused' }, created: false });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(scheduler.schedule).toHaveBeenCalledTimes(1); // 只做幂等查询，不 resume
    expect((scheduler as { resume?: unknown }).resume).toBeUndefined(); // 归档服务绝不调用 resume
  });
});
