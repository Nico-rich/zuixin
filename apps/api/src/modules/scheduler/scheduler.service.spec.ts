import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchedulerService } from './scheduler.service';

const BASE = { ownerUserId: 'u1', name: '测试作业', handler: 'noop' };

function makeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'job-1', organizationId: 'org-1', ownerUserId: 'u1', name: '测试作业', type: 'one-shot',
    cron: null, runAt: new Date(), status: 'scheduled', priority: 0, timeoutMs: 60_000, maxAttempts: 3,
    backoffMs: 2_000, payload: null, handler: 'noop', idempotencyKey: null, traceId: null,
    lastError: null, attempts: 0, scheduledAt: new Date(), completedAt: null, createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

/**
 * 内存态 prisma 替身：updateMany 真实实现条件更新语义（where.status 不匹配 → count 0），
 * findFirst 真实实现 where 等值过滤（幂等命中必须限定 scope——不做过滤这条不变式在单测里不成立），
 * 否则"条件更新/scope 内幂等"这些核心不变式在单测里根本不成立。
 */
function makeService(initialRow?: Record<string, unknown>) {
  // 未指定初始行 = 空库（schedule 的幂等前置查重必须查不到，否则失去"首次创建"语义）
  const state: { row: Record<string, unknown> | null } = { row: initialRow === undefined ? null : makeRow(initialRow) };
  /** where 等值过滤（null 与 undefined 归一化——organizationId 的"个人 scope"即 null） */
  const filter = (where: Record<string, unknown>) =>
    state.row && Object.entries(where).every(([k, v]) => (state.row![k] ?? null) === (v ?? null)) ? state.row : null;
  const prisma = {
    scheduledJob: {
      findUnique: vi.fn(async () => state.row),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => filter(where)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.row = makeRow({ ...data, id: 'job-1' });
        return state.row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id?: string; status?: unknown }; data: Record<string, unknown> }) => {
        const row = state.row;
        if (!row || (where.id && where.id !== row.id)) return { count: 0 };
        const cond = where.status;
        const ok = cond === undefined
          || (typeof cond === 'string' ? row.status === cond
            : Array.isArray((cond as { in?: string[] }).in) ? (cond as { in: string[] }).in.includes(row.status as string) : true);
        if (!ok) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn(async () => { state.row = null; return {}; }),
    },
  };
  // M10-P15（BUG-6）：get() 不再经 authorize，而是自行判定成员身份 + 组织治理态（跨租户 → 404）
  const auth = {
    require: vi.fn().mockResolvedValue('owner'),
    membership: vi.fn(async (_userId: string, organizationId: string | null) => (
      organizationId
        ? { role: 'owner', orgStatus: organizationId === 'org-disabled' ? 'disabled' : 'active' }
        : null
    )),
  };
  const queue = {
    add: vi.fn().mockResolvedValue({ id: 'j' }),
    getDelayed: vi.fn().mockResolvedValue([] as Array<{ id: string; remove: () => Promise<void> }>),
    getWaiting: vi.fn().mockResolvedValue([] as Array<{ id: string; remove: () => Promise<void> }>),
    getRepeatableJobs: vi.fn().mockResolvedValue([] as Array<{ id?: string; name: string; key: string }>),
    removeRepeatableByKey: vi.fn().mockResolvedValue(undefined),
  };
  const svc = new SchedulerService(prisma as never, auth as never, queue as never);
  return { svc, prisma, queue, auth, state };
}

describe('SchedulerService（M8-P5 调度：幂等/状态机/队列投递）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('schedule：delayed 作业落库 scheduled + BullMQ delay=runAt-now（jobId=sched-{id}）', async () => {
    const { svc, prisma, queue } = makeService();
    const runAt = new Date(Date.now() + 60_000);
    const res = await svc.schedule({ ...BASE, type: 'delayed', runAt, organizationId: 'org-1' });
    expect(res.created).toBe(true);
    expect(prisma.scheduledJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'scheduled', type: 'delayed', handler: 'noop', organizationId: 'org-1' }),
    }));
    const opts = queue.add.mock.calls[0][2] as { jobId: string; delay: number };
    expect(opts.jobId).toBe('sched-job-1');
    expect(opts.delay).toBeGreaterThan(55_000);
    expect(opts.delay).toBeLessThanOrEqual(60_000);
  });

  it('schedule：幂等键重复 → 返回同一行（绝不第二个作业/第二次入队）', async () => {
    const { svc, prisma, queue } = makeService();
    const first = await svc.schedule({ ...BASE, idempotencyKey: 'k1' });
    expect(first.created).toBe(true);
    expect(queue.add).toHaveBeenCalledTimes(1);

    const second = await svc.schedule({ ...BASE, idempotencyKey: 'k1' }); // 同键 → 命中已有行
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(queue.add).toHaveBeenCalledTimes(1); // 未再次入队
    expect(prisma.scheduledJob.create).toHaveBeenCalledTimes(1);
  });

  it('schedule：并发同键 → create P2002 → 按 scope 复取赢家行（幂等）', async () => {
    const { svc, prisma, queue } = makeService();
    prisma.scheduledJob.findFirst
      .mockResolvedValueOnce(null) // 前置查重未命中（同 scope 无行）
      .mockResolvedValueOnce(makeRow({ id: 'winner', idempotencyKey: 'k2' })); // P2002 后按 scope 复取赢家
    prisma.scheduledJob.create.mockRejectedValueOnce({ code: 'P2002' });
    const res = await svc.schedule({ ...BASE, idempotencyKey: 'k2' });
    expect(res.created).toBe(false);
    expect(res.job.id).toBe('winner');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('schedule：幂等命中查询限定 scope（idempotencyKey + organizationId + ownerUserId）', async () => {
    const { svc, prisma } = makeService();
    await svc.schedule({ ...BASE, organizationId: 'org-1', idempotencyKey: 'k-scope' });
    expect(prisma.scheduledJob.findFirst).toHaveBeenCalledWith({
      where: { idempotencyKey: 'k-scope', organizationId: 'org-1', ownerUserId: 'u1' },
    });
    // 个人 scope（无 organizationId）→ 按 null 匹配，绝不落到"只按键查"
    await svc.schedule({ ...BASE, idempotencyKey: 'k-personal' });
    expect(prisma.scheduledJob.findFirst).toHaveBeenLastCalledWith({
      where: { idempotencyKey: 'k-personal', organizationId: null, ownerUserId: 'u1' },
    });
  });

  it('schedule：跨 scope 撞全局唯一键 → 404 反枚举（绝不返回他人行/绝不泄漏 payload）', async () => {
    const { svc, prisma, queue } = makeService();
    prisma.scheduledJob.findFirst.mockResolvedValue(null); // scope 内始终查不到（键属于别的组织/用户）
    prisma.scheduledJob.create.mockRejectedValueOnce({ code: 'P2002' }); // 全局唯一键冲突（对方行已存在）
    await expect(svc.schedule({ ...BASE, organizationId: 'org-2', idempotencyKey: 'stolen' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(queue.add).not.toHaveBeenCalled(); // 既不返回对方行，也不抢占
  });

  it('schedule：入队失败 → 回滚行（不留下永不执行的孤儿事实）', async () => {
    const { svc, prisma, queue } = makeService();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.schedule({ ...BASE })).rejects.toThrow('redis down');
    expect(prisma.scheduledJob.delete).toHaveBeenCalledWith({ where: { id: 'job-1' } });
  });

  it('schedule：recurring 用 repeatable（jobId=sched-rec-{id}，pattern=cron）；非法 cron/缺 runAt → 400', async () => {
    const { svc, queue } = makeService();
    await svc.schedule({ ...BASE, type: 'recurring', cron: '*/5 * * * *' });
    const opts = queue.add.mock.calls[0][2] as { jobId: string; repeat: { pattern: string } };
    expect(opts.jobId).toBe('sched-rec-job-1');
    expect(opts.repeat.pattern).toBe('*/5 * * * *');
    await expect(svc.schedule({ ...BASE, type: 'recurring', cron: 'not a cron' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.schedule({ ...BASE, type: 'delayed' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.schedule({ ...BASE, handler: 'bad name!' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('cancel：条件更新（活跃态 → cancelled）+ 队列 job 移除（含重投变体）；已终态 → 400', async () => {
    const { svc, prisma, queue, state } = makeService({ status: 'scheduled' });
    const removable = { id: 'sched-job-1-r1', remove: vi.fn().mockResolvedValue(undefined) };
    queue.getDelayed.mockResolvedValueOnce([removable]);
    const res = await svc.cancel('u1', 'job-1');
    expect(res).toEqual({ cancelled: true, status: 'cancelled' });
    expect(prisma.scheduledJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-1', status: { in: ['pending', 'scheduled', 'running', 'paused'] } },
      data: expect.objectContaining({ status: 'cancelled' }),
    }));
    expect(removable.remove).toHaveBeenCalled(); // 重投变体一并清理

    state.row = makeRow({ status: 'completed' });
    await expect(svc.cancel('u1', 'job-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('pause：recurring 移除 repeatable；resume：状态回 scheduled + 重建 repeatable', async () => {
    const { svc, prisma, queue, state } = makeService({ type: 'recurring', cron: '0 * * * *', status: 'scheduled' });
    queue.getRepeatableJobs.mockResolvedValueOnce([{ name: 'sched-rec-job-1', key: 'k' }]);
    await svc.pause('u1', 'job-1');
    expect(state.row!.status).toBe('paused');
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('k');

    await svc.resume('u1', 'job-1');
    expect(prisma.scheduledJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-1', status: { in: ['paused', 'dead'] } }, // Pre-M9 G9：可恢复 = paused/dead
      data: expect.objectContaining({ status: 'scheduled', attempts: 0 }),
    }));
    expect((queue.add.mock.calls.at(-1)![2] as { jobId: string }).jobId).toBe('sched-rec-job-1');
    expect(state.row!.status).toBe('scheduled');

    state.row = makeRow({ status: 'completed' });
    await expect(svc.resume('u1', 'job-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('G9：dead（重试超限/stalled 判死）可显式 resume——attempts 归零、lastError/completedAt 清空、重新投递', async () => {
    const { svc, prisma, queue, state } = makeService({
      type: 'delayed', runAt: new Date(Date.now() - 1000),
      status: 'dead', attempts: 3, lastError: 'stalled：心跳中断', completedAt: new Date(),
    });
    const res = await svc.resume('u1', 'job-1');
    expect(res).toEqual({ resumed: true, status: 'scheduled' });
    expect(prisma.scheduledJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-1', status: { in: ['paused', 'dead'] } },
      data: { status: 'scheduled', attempts: 0, lastError: null, completedAt: null }, // 重试预算与失败留痕一并重置
    }));
    expect((queue.add.mock.calls.at(-1)![2] as { jobId: string }).jobId).toBe('sched-job-1');
    expect(state.row!.status).toBe('scheduled');
  });

  it('G9：终态/进行中状态一律不可 resume（completed/cancelled/running/pending/scheduled）', async () => {
    for (const status of ['completed', 'cancelled', 'running', 'pending', 'scheduled']) {
      const { svc, state } = makeService({ status });
      state.row = makeRow({ status }); // 条件更新失配（count=0）
      await expect(svc.resume('u1', 'job-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('pause/resume：one-shot 移除延迟 job；resume 按剩余时间重建（已过期 → 立即）', async () => {
    const { svc, queue, state } = makeService({ type: 'delayed', runAt: new Date(Date.now() - 1000), status: 'scheduled' });
    const removable = { id: 'sched-job-1', remove: vi.fn().mockResolvedValue(undefined) };
    queue.getDelayed.mockResolvedValueOnce([removable]);
    await svc.pause('u1', 'job-1');
    expect(removable.remove).toHaveBeenCalled();
    await svc.resume('u1', 'job-1');
    expect((queue.add.mock.calls.at(-1)![2] as { jobId: string; delay: number }).jobId).toBe('sched-job-1');
    expect((queue.add.mock.calls.at(-1)![2] as { delay: number }).delay).toBe(0);
    expect(state.row!.status).toBe('scheduled');
  });

  it('enqueueRetry：新 jobId 变体（避免与仍 active 的 job 撞 id）+ 退避延迟', async () => {
    const { svc, queue } = makeService();
    await svc.enqueueRetry('job-1', 400, 2);
    const opts = queue.add.mock.calls[0][2] as { jobId: string; delay: number };
    expect(opts.jobId).toBe('sched-job-1-r2');
    expect(opts.delay).toBe(400);
  });

  it('handler 注册表：内置 noop；未注册 → undefined（worker 侧判失败，绝不执行任意代码）', () => {
    const { svc } = makeService();
    expect(svc.listHandlers()).toContain('noop');
    expect(typeof svc.getHandler('noop')).toBe('function');
    expect(svc.getHandler('任意字符串')).toBeUndefined();
    svc.registerHandler('e2e.fail', async () => undefined);
    expect(svc.listHandlers()).toEqual(['e2e.fail', 'noop']);
    expect(() => svc.registerHandler('bad name!', () => undefined)).toThrow();
  });

  it('get/list：组织作业校验成员身份；个人作业按 owner 过滤（他人不可见）', async () => {
    const { svc, prisma, auth, state } = makeService({ organizationId: 'org-9' });
    await svc.get('u1', 'job-1');
    // M10-P15（回滚"一律 404"）：组织作业归属裁决**独家**委托 `auth.require` —— 非成员 403、
    // 禁用组织 403 ORG_DISABLED 是 M8-P5 冻结的错误码语义（m8-p5-scheduler-events e2e 锁定），
    // 服务层绝不自行把非成员折叠成 404。
    expect(auth.require).toHaveBeenCalledWith('u1', 'org-9');

    await svc.list('u1', { organizationId: 'org-9' });
    expect(prisma.scheduledJob.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org-9' } }));

    await svc.list('u1', {});
    expect(prisma.scheduledJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ownerUserId: 'u1', organizationId: null },
    }));

    state.row = makeRow({ organizationId: null, ownerUserId: 'other' });
    await expect(svc.get('u1', 'job-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('M10-P15（冻结语义）：组织作业的非成员 → 403 原样冒泡（绝不改写为 404）；禁用组织 → 403 ORG_DISABLED', async () => {
    const foreign = makeService({ organizationId: 'org-9' });
    // 非成员：`auth.require` 抛 403 FORBIDDEN → 服务层**不得**吞掉改写成 404（M8-P5 冻结错误码）
    foreign.auth.require.mockRejectedValueOnce(Object.assign(new Error('无权访问该组织'), { status: 403, code: 'FORBIDDEN' }));
    await expect(foreign.svc.get('u-foreign', 'job-1')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });

    // 禁用组织：冻结态对**读**路径同样生效（此前只挡写路径，读路径 200 泄露组织数据）
    // 错误形状与守卫同源：HttpException(403, { code: 'ORG_DISABLED' })——同样由 require 独家裁决
    const disabled = makeService({ organizationId: 'org-disabled' });
    disabled.auth.require.mockRejectedValueOnce(Object.assign(new Error('组织已被禁用，无法访问其资源'), {
      status: 403, response: { code: 'ORG_DISABLED' },
    }));
    await expect(disabled.svc.get('u1', 'job-1')).rejects.toMatchObject({
      status: 403, response: { code: 'ORG_DISABLED' },
    });
  });
});
