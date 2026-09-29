import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  AnalyticsAggregationService, ANALYTICS_AGGREGATION_HANDLER, ANALYTICS_AGGREGATION_CRON,
  ANALYTICS_AGGREGATION_IDEMPOTENCY_KEY, ANALYTICS_AGGREGATION_JOB_NAME,
} from './analytics-aggregation.service';
import {
  analyticsAggregationDays, DEFAULT_ANALYTICS_AGGREGATION_DAYS, DEFAULT_ANALYTICS_AGGREGATION_MAX_ORGS,
} from '../analytics/analytics.service';
import type { RefreshOrganizationsResult } from '../analytics/analytics.service';
import type { JobHandler, JobHandlerContext } from './scheduler.service';

/**
 * M12-P5 单测（审计项：「Analytics 没有 cron 聚合」）：不触 DB/队列/聚合逻辑——
 * prisma/scheduler/analytics/metrics 均为替身。
 *
 * 断言契约：本服务只做「周期触发 + 观测」（聚合的有界轮转/失败隔离/幂等全在
 * AnalyticsService.refreshStaleOrganizations 内，已有其自身单测覆盖），
 * 因此这里断言的是：options 原样透传（绝不二次解析/塞默认值）、指标如实回显、
 * failed 可见、抛错向上暴露（交 scheduler 重试，绝不吞成"成功"）、停机不留定时器。
 */
function makeService(input: {
  /** refreshStaleOrganizations 的返回覆盖（缺省 = 3 组织 / 6 周期全成功） */
  result?: Partial<RefreshOrganizationsResult>;
  /** 让 refreshStaleOrganizations 抛错（模拟 DB 不可达等） */
  reject?: Error;
} = {}) {
  const prisma = {
    user: { findFirst: vi.fn(async () => ({ id: 'admin-1' })) },
    scheduledJob: { findFirst: vi.fn(async () => null as { id: string; status: string } | null) },
  };
  const handlers = new Map<string, JobHandler>();
  const scheduler = {
    registerHandler: vi.fn((name: string, fn: JobHandler) => { handlers.set(name, fn); }),
    schedule: vi.fn(async () => ({ job: { id: 'sched-1', status: 'scheduled' }, created: true })),
    getHandler: (name: string) => handlers.get(name),
  };
  const analytics = {
    // 可变参数：否则 `mock.calls[0]` 是空元组 `[]`，`calls[0][0]` 在 strict 下不可访问（TS2493）
    refreshStaleOrganizations: vi.fn(async (..._args: unknown[]): Promise<RefreshOrganizationsResult> => {
      if (input.reject) throw input.reject;
      return {
        organizations: 3, days: 2, periods: 6, refreshed: 6, failed: 0, truncated: false,
        nextCursor: null, from: '2026-09-28', to: '2026-09-29', ...input.result,
      };
    }),
  };
  const metrics = { recordMetric: vi.fn(async () => undefined) };
  const svc = new AnalyticsAggregationService(prisma as never, scheduler as never, analytics as never, metrics as never);
  return { svc, prisma, scheduler, analytics, metrics, handlers };
}

const ctx = (payload: Record<string, unknown> | null = null): JobHandlerContext => ({
  jobId: 'job-1', name: 'n', handler: ANALYTICS_AGGREGATION_HANDLER, attempt: 1,
  payload, organizationId: null, traceId: null,
});

describe('AnalyticsAggregationService.run（M12-P5：委托有界轮转 + 观测，绝不重复实现聚合）', () => {
  const prevEnv = {
    days: process.env.ANALYTICS_AGGREGATION_DAYS,
    daysCamel: process.env.analyticsAggregationDays,
  };
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANALYTICS_AGGREGATION_DAYS;
    delete process.env.analyticsAggregationDays;
  });
  afterEach(() => {
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('ANALYTICS_AGGREGATION_DAYS', prevEnv.days);
    restore('analyticsAggregationDays', prevEnv.daysCamel);
  });

  it('正常一轮：options 原样透传 AnalyticsService + 指标记 refreshed 与 labels（平台级 organizationId 显式 null）', async () => {
    const { svc, analytics, metrics } = makeService();
    const now = new Date('2026-09-29T12:00:00.000Z');
    const res = await svc.run({ maxOrganizations: 5, days: 2, now });
    expect(analytics.refreshStaleOrganizations).toHaveBeenCalledWith({ maxOrganizations: 5, days: 2, now });
    expect(res).toMatchObject({ organizations: 3, periods: 6, refreshed: 6 });
    expect(metrics.recordMetric).toHaveBeenCalledWith(
      'analytics_aggregation_refreshed', 6, 'count',
      expect.objectContaining({
        organizations: 3, periods: 6, failed: 0, truncated: false, from: '2026-09-28', to: '2026-09-29',
      }),
      null,
    );
  });

  it('无 payload ⇒ 传空对象（绝不塞默认值）：days 由 AnalyticsService 按 env 解析，env 缺省/非法回落 2 天', async () => {
    const { svc, analytics } = makeService();
    await svc.run();
    expect(analytics.refreshStaleOrganizations).toHaveBeenCalledWith({});
    expect(Object.keys(analytics.refreshStaleOrganizations.mock.calls[0][0] as Record<string, unknown>)).not.toContain('days');

    process.env.ANALYTICS_AGGREGATION_DAYS = '5';
    expect(analyticsAggregationDays()).toBe(5); // env 生效（窗口由聚合侧统一解析，服务端不复制一份）
    process.env.ANALYTICS_AGGREGATION_DAYS = '0';
    expect(analyticsAggregationDays()).toBe(DEFAULT_ANALYTICS_AGGREGATION_DAYS); // 非法/非正绝不静默变成"全历史重算"
    expect(DEFAULT_ANALYTICS_AGGREGATION_DAYS).toBe(2);
    expect(DEFAULT_ANALYTICS_AGGREGATION_MAX_ORGS).toBe(50); // 单轮组织预算（有界工作）
  });

  it('failed>0 ⇒ 告警可见（失败组织下轮重试），但本轮照常返回并记指标（失败隔离在聚合侧，不在此处吞）', async () => {
    const { svc, metrics } = makeService({ result: { organizations: 4, periods: 8, refreshed: 6, failed: 2 } });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(svc.run({ maxOrganizations: 4 })).resolves.toMatchObject({ refreshed: 6, failed: 2 });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ organizations: 4, failed: 2, from: '2026-09-28', to: '2026-09-29' }),
        expect.stringContaining('部分失败'),
      );
      expect(metrics.recordMetric).toHaveBeenCalledWith(
        'analytics_aggregation_refreshed', 6, 'count',
        expect.objectContaining({ failed: 2 }),
        null,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('refreshed=0（空库/无可刷组织）也记指标：0 是"跑了但没得刷"的活性信号，不是"没跑"', async () => {
    const { svc, metrics } = makeService({ result: { organizations: 0, periods: 0, refreshed: 0, from: '2026-09-29', to: '2026-09-29' } });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(svc.run()).resolves.toMatchObject({ refreshed: 0, failed: 0 });
      expect(metrics.recordMetric).toHaveBeenCalledWith(
        'analytics_aggregation_refreshed', 0, 'count',
        expect.objectContaining({ organizations: 0, failed: 0 }),
        null,
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('聚合抛错 ⇒ 异常向上暴露（作业按 maxAttempts/backoff 重试），绝不吞成"成功"也不留半条指标', async () => {
    const { svc, metrics } = makeService({ reject: new Error('connect ECONNREFUSED') });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(svc.run()).rejects.toThrow('connect ECONNREFUSED');
      expect(metrics.recordMetric).not.toHaveBeenCalled(); // 本轮无"已刷新"事实可记
      expect(warn).not.toHaveBeenCalled();                 // 也不伪造成"部分失败"——失败原样交给 scheduler
    } finally {
      warn.mockRestore();
    }
  });
});

describe('AnalyticsAggregationService 启动接线（handler 注册 + 周期作业开通 + 停机不留定时器）', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('onModuleInit：注册 handler=analytics.aggregation 并按 metric-retention 同范式开通 recurring 作业', async () => {
    const { svc, scheduler } = makeService();
    await svc.onModuleInit();
    expect(scheduler.registerHandler).toHaveBeenCalledWith(ANALYTICS_AGGREGATION_HANDLER, expect.any(Function));
    expect(scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({
      handler: ANALYTICS_AGGREGATION_HANDLER, type: 'recurring', cron: ANALYTICS_AGGREGATION_CRON,
      idempotencyKey: ANALYTICS_AGGREGATION_IDEMPOTENCY_KEY, ownerUserId: 'admin-1', organizationId: null,
      payload: null, timeoutMs: 300_000, maxAttempts: 3, backoffMs: 5_000,
    }));
    svc.onModuleDestroy();
  });

  it('cron 常量：粗校验口径的 5 段 cron（每段只含数字/通配/区间字符），与 metric-retention 同一范式', () => {
    expect(ANALYTICS_AGGREGATION_CRON).toBe('*/5 * * * *');
    const fields = ANALYTICS_AGGREGATION_CRON.split(/\s+/);
    expect(fields).toHaveLength(5);
    for (const field of fields) expect(field).toMatch(/^(\*|[\d,\-*/]+)$/); // SchedulerService 的 CRON_FIELD 口径
  });

  it('handler 真实可执行：payload 作为 options 原样透传（不写 payload ⇒ 全部按默认/env 生效）', async () => {
    const { svc, scheduler, analytics } = makeService();
    await svc.onModuleInit();
    const handler = scheduler.getHandler(ANALYTICS_AGGREGATION_HANDLER)!;
    await expect(handler(ctx({ maxOrganizations: 5, days: 3 }))).resolves.toBeUndefined(); // 契约：只回报成功/失败
    expect(analytics.refreshStaleOrganizations).toHaveBeenCalledWith({ maxOrganizations: 5, days: 3 });

    await handler(ctx(null));
    expect(analytics.refreshStaleOrganizations).toHaveBeenLastCalledWith({});
    expect(analytics.refreshStaleOrganizations).toHaveBeenCalledTimes(2);
    svc.onModuleDestroy();
  });

  it('handler 遇聚合抛错 ⇒ 拒绝向上暴露给 scheduler（按失败重试），绝不崩在注册表里、不记指标', async () => {
    const { svc, scheduler, metrics } = makeService({ reject: new Error('analytics 不可达') });
    await svc.onModuleInit();
    const handler = scheduler.getHandler(ANALYTICS_AGGREGATION_HANDLER)!;
    await expect(handler(ctx(null))).rejects.toThrow('analytics 不可达');
    expect(metrics.recordMetric).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('onModuleDestroy：停机清定时器（无泄漏），此后绝不再探测', async () => {
    const { svc, scheduler } = makeService();
    const baseline = vi.getTimerCount();
    await svc.onModuleInit();
    expect(vi.getTimerCount()).toBe(baseline + 1); // 已开通 ⇒ 转入慢巡检（唯一新增定时器）
    svc.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(baseline);     // 清干净：进程退出不被探测定时器拖住
    svc.onModuleDestroy();                          // 幂等
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(scheduler.schedule).toHaveBeenCalledTimes(1); // 停机后绝无残留探测
  });

  it('作业身份常量稳定（幂等键版本化：语义变更才换 v2，绝不无声换键产生第二个作业）', () => {
    expect(ANALYTICS_AGGREGATION_HANDLER).toBe('analytics.aggregation');
    expect(ANALYTICS_AGGREGATION_IDEMPOTENCY_KEY).toBe('platform:analytics-aggregation:v1');
    expect(ANALYTICS_AGGREGATION_JOB_NAME).toContain('Analytics');
  });
});
