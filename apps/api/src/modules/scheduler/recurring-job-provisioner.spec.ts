import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecurringJobProvisioner, ProvisionOutcome } from './recurring-job-provisioner';

/**
 * M11-P8（D2-18）单测：平台周期作业开通器的**探测/重试/不复活**契约。
 * 不触 DB/队列；定时器注入（记录 delay 并手动驱动）→ 退避序列可精确断言，不依赖真实计时器。
 */
const SPEC = {
  name: '测试周期作业', handler: 'test.job', cron: '*/15 * * * *', idempotencyKey: 'platform:test:v1',
  timeoutMs: 120_000, maxAttempts: 3, backoffMs: 5_000, inactiveHint: '需运维显式 resume',
};

const RETRY_BASE = 1_000;
const RETRY_MAX = 8_000;
const PROBE = 60_000;

function makeProvisioner() {
  const state: { row: { id: string; status: string } | null; admin: { id: string } | null; schedule: 'ok' | 'exists' | 'throw' } = {
    row: null, admin: { id: 'admin-1' }, schedule: 'ok',
  };
  const prisma = {
    scheduledJob: { findFirst: vi.fn(async () => state.row) },
    user: { findFirst: vi.fn(async () => state.admin) },
  };
  const scheduler = {
    schedule: vi.fn(async () => {
      if (state.schedule === 'throw') throw new Error('connect ECONNREFUSED');
      if (state.schedule === 'exists') return { job: { id: 'sched-existing', status: 'scheduled' }, created: false };
      state.row = { id: 'sched-new', status: 'scheduled' };
      return { job: state.row, created: true };
    }),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  /** 注入定时器：只记录（不真实触发）——测试显式驱动，退避序列可精确断言 */
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const provisioner = new RecurringJobProvisioner({
    prisma: prisma as never,
    scheduler: scheduler as never,
    logger: logger as never,
    spec: SPEC,
    probeMs: PROBE,
    retryBaseMs: RETRY_BASE,
    retryMaxMs: RETRY_MAX,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref: () => undefined } as unknown as NodeJS.Timeout; },
    clearTimer: () => undefined,
  });
  return { provisioner, prisma, scheduler, logger, timers, state };
}

describe('RecurringJobProvisioner（M11-P8 D2-18：周期性探测 + 退避重试开通，绝不复活人工停用）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('行缺失 + 有 admin → 开通 recurring 周期作业（幂等键/平台归属/organizationId=null），结论 active', async () => {
    const { provisioner, scheduler, timers } = makeProvisioner();
    await expect(provisioner.probe()).resolves.toBe('active');
    expect(scheduler.schedule).toHaveBeenCalledWith({
      ownerUserId: 'admin-1', organizationId: null,
      name: SPEC.name, handler: SPEC.handler, type: 'recurring', cron: SPEC.cron,
      timeoutMs: SPEC.timeoutMs, maxAttempts: SPEC.maxAttempts, backoffMs: SPEC.backoffMs,
      payload: null, idempotencyKey: SPEC.idempotencyKey,
    });
    // 已开通 → 转入慢巡检（不是重试节奏）
    expect(timers.at(-1)!.ms).toBe(PROBE);
  });

  it('行已存在且活跃 → 绝不重复开通（连 schedule 都不调用），结论 active + 慢巡检', async () => {
    const { provisioner, scheduler, timers, state } = makeProvisioner();
    state.row = { id: 'sched-existing', status: 'scheduled' };
    await expect(provisioner.probe()).resolves.toBe('active');
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(timers.at(-1)!.ms).toBe(PROBE);
  });

  it('行存在但 paused/dead/终态 → 结论 inactive，绝不复活（不 resume/不重建），只慢巡检 + 告警', async () => {
    const { provisioner, scheduler, logger, timers, state } = makeProvisioner();
    state.row = { id: 'sched-paused', status: 'paused' };
    await expect(provisioner.probe()).resolves.toBe('inactive');
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect((scheduler as { resume?: unknown }).resume).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(timers.at(-1)!.ms).toBe(PROBE);

    // 状态未变 → 巡检不刷屏（相同状态不再告警）
    await provisioner.probe();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('无 admin 用户（seed 未跑）→ 结论 retry + 退避重试（不是"告警一次就永久停摆"）', async () => {
    const { provisioner, scheduler, timers, state } = makeProvisioner();
    state.admin = null;
    await expect(provisioner.probe()).resolves.toBe('retry');
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(timers.at(-1)!.ms).toBe(RETRY_BASE);

    // seed 完成（admin 出现）→ 驱动重试定时器 → 自动开通
    state.admin = { id: 'admin-2' };
    timers.at(-1)!.fn();
    await vi.waitFor(() => expect(scheduler.schedule).toHaveBeenCalledTimes(1));
    expect(timers.at(-1)!.ms).toBe(PROBE); // 开通成功 → 回到慢巡检
  });

  it('开通抛错（DB/Redis 不可达）→ retry + 指数退避（base → 2× → 封顶 retryMaxMs）', async () => {
    const { provisioner, timers, state } = makeProvisioner();
    state.schedule = 'throw';
    await expect(provisioner.probe()).resolves.toBe('retry');
    const delays = [timers.at(-1)!.ms];
    for (let i = 0; i < 5; i++) {
      await provisioner.probe();
      delays.push(timers.at(-1)!.ms);
    }
    expect(delays).toEqual([RETRY_BASE, RETRY_BASE * 2, RETRY_BASE * 4, RETRY_MAX, RETRY_MAX, RETRY_MAX]);
  });

  it('探测绝不抛错（prisma 异常 → retry；启动路径安全）', async () => {
    const { provisioner, prisma, timers } = makeProvisioner();
    prisma.scheduledJob.findFirst.mockRejectedValue(new Error('db down'));
    await expect(provisioner.probe()).resolves.toBe('retry');
    expect(timers.at(-1)!.ms).toBe(RETRY_BASE);
  });

  it('并发开通竞态：幂等命中（created=false，赢家为活跃态）→ active，绝不产生第二个作业', async () => {
    const { provisioner, timers, state } = makeProvisioner();
    state.schedule = 'exists';
    await expect(provisioner.probe()).resolves.toBe('active');
    expect(timers.at(-1)!.ms).toBe(PROBE);
  });

  it('stop()：幂等停机，此后 probe 一律 stopped 且不再安排定时器（不拖住进程退出）', async () => {
    const { provisioner, timers } = makeProvisioner();
    await provisioner.probe();
    const before = timers.length;
    provisioner.stop();
    provisioner.stop();
    await expect(provisioner.probe()).resolves.toBe('stopped' satisfies ProvisionOutcome);
    expect(timers.length).toBe(before);
    expect(provisioner.pending).toBe(false);
  });
});
