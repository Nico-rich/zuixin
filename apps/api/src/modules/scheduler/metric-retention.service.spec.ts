import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MetricRetentionService, METRIC_RETENTION_HANDLER, METRIC_RETENTION_CRON, METRIC_RETENTION_IDEMPOTENCY_KEY,
  DEFAULT_METRIC_RETENTION_DAYS,
} from './metric-retention.service';
import type { JobHandler, JobHandlerContext } from './scheduler.service';

/**
 * M11-P8（D1-07）单测：不触 DB/队列——prisma/scheduler/metrics 均为替身。
 * 断言契约：按名轮转（命中 [name, sampledAt] 索引）+ 批量 + 有界 + 条件删除幂等 + 保留天数 env/payload + 活性指标。
 */
const DAY_MS = 24 * 60 * 60 * 1_000;

function makeService(prismaOverrides: Record<string, unknown> = {}, scheduleResult?: unknown) {
  const prisma = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'admin-1' }) },
    scheduledJob: { findFirst: vi.fn().mockResolvedValue(null) },
    metricSample: {
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue(null),
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
  };
  const metrics = { recordMetric: vi.fn().mockResolvedValue(undefined) };
  const svc = new MetricRetentionService(prisma as never, scheduler as never, metrics as never);
  return { svc, prisma, scheduler, metrics, handlers };
}

const rows = (n: number, prefix = 'ms') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
/** 指标名替身（groupBy 返回形态） */
const names = (...ns: string[]) => ns.map((name) => ({ name }));

describe('MetricRetentionService.purgeExpired（D1-07：超期样本删除 = 批量 + 有界 + 幂等）', () => {
  const prevDays = process.env.METRIC_RETENTION_DAYS;
  beforeEach(() => { vi.clearAllMocks(); delete process.env.METRIC_RETENTION_DAYS; });
  afterEach(() => {
    if (prevDays === undefined) delete process.env.METRIC_RETENTION_DAYS;
    else process.env.METRIC_RETENTION_DAYS = prevDays;
    delete process.env.metricRetentionDays;
  });

  it('表内无样本 → 零副作用（不查候选、不删），指标仍记 0（活性信号）', async () => {
    const { svc, prisma, metrics } = makeService();
    await expect(svc.purgeExpired()).resolves.toMatchObject({ deleted: 0, scanned: 0, batches: 0, names: 0, truncated: false });
    expect(prisma.metricSample.findMany).not.toHaveBeenCalled();
    expect(prisma.metricSample.deleteMany).not.toHaveBeenCalled();
    expect(metrics.recordMetric).toHaveBeenCalledWith('metric_sample_purge_count', 0, 'count', expect.anything(), null);
  });

  it('候选口径：按指标名轮转（命中 [name, sampledAt] 索引）+ 严格早于 cutoff + 最旧优先 + 限量', async () => {
    const { svc, prisma } = makeService();
    prisma.metricSample.groupBy.mockResolvedValue(names('request_count'));
    prisma.metricSample.findMany.mockResolvedValueOnce(rows(2)).mockResolvedValue([]);
    prisma.metricSample.deleteMany.mockResolvedValue({ count: 2 });
    const now = new Date('2026-09-28T00:00:00.000Z');
    const res = await svc.purgeExpired({ now });
    expect(res).toMatchObject({ deleted: 2, scanned: 2, batches: 1, retentionDays: DEFAULT_METRIC_RETENTION_DAYS });
    const q = prisma.metricSample.findMany.mock.calls[0][0];
    expect(q.where.name).toBe('request_count'); // 等值前缀 → 复合索引可用（不是全表扫）
    expect(q.where.sampledAt).toEqual({ lt: new Date(now.getTime() - DEFAULT_METRIC_RETENTION_DAYS * DAY_MS) });
    expect(q.orderBy).toEqual({ sampledAt: 'asc' });
    expect(q.take).toBe(1_000);
    expect(q.select).toEqual({ id: true });
  });

  it('条件删除：WHERE 同时含 id 集与 sampledAt < cutoff（并发/重复执行唯一赢家，绝不越界删窗口内的行）', async () => {
    const { svc, prisma } = makeService();
    prisma.metricSample.groupBy.mockResolvedValue(names('error_count'));
    prisma.metricSample.findMany.mockResolvedValueOnce(rows(2, 'a')).mockResolvedValue([]);
    prisma.metricSample.deleteMany.mockResolvedValue({ count: 2 });
    const now = new Date('2026-09-28T00:00:00.000Z');
    const res = await svc.purgeExpired({ now, retentionDays: 7 });
    expect(prisma.metricSample.deleteMany.mock.calls[0][0].where).toEqual({
      id: { in: ['a-0', 'a-1'] },
      sampledAt: { lt: new Date(now.getTime() - 7 * DAY_MS) },
    });
    expect(res.cutoff).toEqual(new Date(now.getTime() - 7 * DAY_MS));
  });

  it('幂等：第二次执行（候选已被删光）→ 零删除、零批次；空名不轮转', async () => {
    const { svc, prisma } = makeService();
    prisma.metricSample.groupBy.mockResolvedValue(names('queue_depth'));
    prisma.metricSample.findMany.mockResolvedValueOnce(rows(1)).mockResolvedValue([]);
    prisma.metricSample.deleteMany.mockResolvedValueOnce({ count: 1 });
    await expect(svc.purgeExpired()).resolves.toMatchObject({ deleted: 1, batches: 1 });
    const calls = prisma.metricSample.findMany.mock.calls.length;
    await expect(svc.purgeExpired()).resolves.toMatchObject({ deleted: 0, batches: 0 }); // 第二轮：候选为空 → 多打了一次查询即停
    expect(prisma.metricSample.findMany.mock.calls.length).toBe(calls + 1);
    expect(prisma.metricSample.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('并发竞争（另一进程抢先删，deleteMany count=0）→ 删除数如实为 0，绝不虚报', async () => {
    const { svc, prisma, metrics } = makeService();
    prisma.metricSample.groupBy.mockResolvedValue(names('request_count'));
    prisma.metricSample.findMany.mockResolvedValueOnce(rows(2)).mockResolvedValue([]);
    prisma.metricSample.deleteMany.mockResolvedValueOnce({ count: 0 }); // 输给并发赢家
    await expect(svc.purgeExpired()).resolves.toMatchObject({ scanned: 2, deleted: 0 });
    expect(metrics.recordMetric).toHaveBeenCalledWith('metric_sample_purge_count', 0, 'count', expect.anything(), null);
  });

  it('多名轮转：每名各一批（大指标名不饿死其它名），批次/删除数汇总正确', async () => {
    const { svc, prisma } = makeService();
    prisma.metricSample.groupBy.mockResolvedValue(names('a', 'b'));
    prisma.metricSample.findMany
      .mockResolvedValueOnce(rows(2, 'a1'))  // a 第 1 批（满批）
      .mockResolvedValueOnce(rows(1, 'b1'))  // b 第 1 批（不满批）
      .mockResolvedValueOnce(rows(1, 'a2'))  // a 第 2 批（不满批 → 下一轮 a 无候选）
      .mockResolvedValue([]);
    prisma.metricSample.deleteMany
      .mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    const res = await svc.purgeExpired({ batchSize: 2, now: new Date() });
    expect(res).toMatchObject({ batches: 3, scanned: 4, deleted: 4, names: 2, truncated: false });
    // 轮转顺序：a → b → a → b → …（每轮每名各一批，直到全员无候选）
    expect(prisma.metricSample.findMany.mock.calls.map((c) => c[0].where.name))
      .toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
  });

  it('单次执行有界：批次预算用尽即停（剩余留给下个周期）；确认仍有候选才告警 truncated', async () => {
    const { svc, prisma } = makeService();
    prisma.metricSample.groupBy.mockResolvedValue(names('a'));
    prisma.metricSample.findMany.mockResolvedValue(rows(2)); // 永远满批（模拟海量存量）
    prisma.metricSample.deleteMany.mockResolvedValue({ count: 2 });
    prisma.metricSample.findFirst.mockResolvedValue({ id: 'still-expired' });
    const res = await svc.purgeExpired({ batchSize: 2, maxBatches: 3, now: new Date() });
    expect(res).toMatchObject({ batches: 3, scanned: 6, deleted: 6, truncated: true });
    expect(prisma.metricSample.findMany).toHaveBeenCalledTimes(3); // 绝不无界循环

    // 预算恰好删完（确认查询无候选）→ 不误报 truncated
    prisma.metricSample.findFirst.mockResolvedValue(null);
    await expect(svc.purgeExpired({ batchSize: 2, maxBatches: 3, now: new Date() })).resolves.toMatchObject({ truncated: false });
  });

  it('保留天数：env METRIC_RETENTION_DAYS 可覆盖；非法/非正回落默认 30 天（绝不静默删光或停摆）', async () => {
    const { svc, prisma } = makeService();
    process.env.METRIC_RETENTION_DAYS = '7';
    const now = new Date('2026-09-28T12:00:00.000Z');
    prisma.metricSample.groupBy.mockResolvedValue(names('a'));
    prisma.metricSample.findMany.mockResolvedValue([]);
    await expect(svc.purgeExpired({ now })).resolves.toMatchObject({ retentionDays: 7 });
    expect(prisma.metricSample.findMany.mock.calls[0][0].where.sampledAt.lt).toEqual(new Date(now.getTime() - 7 * DAY_MS));

    process.env.METRIC_RETENTION_DAYS = '0'; // 0/负数/NaN 绝不静默变成"删光"
    await expect(svc.purgeExpired()).resolves.toMatchObject({ retentionDays: DEFAULT_METRIC_RETENTION_DAYS });
  });

  it('指标记录删除数（payload 覆盖天数时 labels 回显生效值；平台级归属 null）', async () => {
    const { svc, prisma, metrics } = makeService();
    prisma.metricSample.groupBy.mockResolvedValue(names('a'));
    prisma.metricSample.findMany.mockResolvedValueOnce(rows(3)).mockResolvedValue([]);
    prisma.metricSample.deleteMany.mockResolvedValue({ count: 3 });
    await svc.purgeExpired({ retentionDays: 3, now: new Date() });
    expect(metrics.recordMetric).toHaveBeenCalledWith(
      'metric_sample_purge_count', 3, 'count',
      expect.objectContaining({ retentionDays: 3, batches: 1, names: 1, truncated: false }),
      null,
    );
  });
});

describe('MetricRetentionService 启动接线（handler 注册 + 周期作业开通，绝不阻塞启动）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('onModuleInit：注册 handler=metrics.retention；开通 recurring 周期作业（幂等键 + cron + 平台 admin 归属）', async () => {
    const { svc, scheduler } = makeService();
    await svc.onModuleInit();
    expect(scheduler.registerHandler).toHaveBeenCalledWith(METRIC_RETENTION_HANDLER, expect.any(Function));
    expect(scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({
      handler: METRIC_RETENTION_HANDLER, type: 'recurring', cron: METRIC_RETENTION_CRON,
      idempotencyKey: METRIC_RETENTION_IDEMPOTENCY_KEY, ownerUserId: 'admin-1', organizationId: null,
    }));
    expect(METRIC_RETENTION_CRON.split(/\s+/)).toHaveLength(5); // 每日一次（scheduler 的 cron 粗校验口径）
    svc.onModuleDestroy();
  });

  it('handler 真实可执行：payload 作为覆盖项传入删除（周期触发 → 保留策略生效）', async () => {
    const { svc, prisma, scheduler } = makeService();
    await svc.onModuleInit();
    prisma.metricSample.groupBy.mockResolvedValue(names('a'));
    prisma.metricSample.findMany.mockResolvedValueOnce(rows(1)).mockResolvedValue([]);
    prisma.metricSample.deleteMany.mockResolvedValue({ count: 1 });
    const handler = scheduler.getHandler(METRIC_RETENTION_HANDLER)!;
    await handler({
      jobId: 'j', name: 'n', handler: METRIC_RETENTION_HANDLER, attempt: 1,
      payload: { batchSize: 1, retentionDays: 2 }, organizationId: null, traceId: null,
    } as JobHandlerContext);
    expect(prisma.metricSample.findMany.mock.calls[0][0].take).toBe(1);
    expect(prisma.metricSample.deleteMany).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });

  it('无 admin 用户（未初始化的库）→ 不开通、不抛错（启动照常；稍后自动重试——D2-18）', async () => {
    const { svc, scheduler } = makeService({ user: { findFirst: vi.fn().mockResolvedValue(null) } });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(scheduler.registerHandler).toHaveBeenCalled(); // handler 仍注册（手工作业可执行）
    svc.onModuleDestroy();
  });

  it('开通失败（DB/Redis 不可达）→ 只告警，绝不阻断进程启动', async () => {
    const { svc, scheduler } = makeService({}, null);
    scheduler.schedule.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    svc.onModuleDestroy();
  });

  it('已注册且非活跃（paused/dead）→ 不重复开通、绝不自动复活', async () => {
    const { svc, scheduler } = makeService({
      scheduledJob: { findFirst: vi.fn().mockResolvedValue({ id: 'sched-1', status: 'dead' }) },
    }, { job: { id: 'sched-1', status: 'dead' }, created: false });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect((scheduler as { resume?: unknown }).resume).toBeUndefined();
    svc.onModuleDestroy();
  });
});
