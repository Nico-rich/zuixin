import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowLeaseService } from './workflow-lease.service';

/**
 * D2-04（兜底侧）：`recoverStale` 是「终态事件丢失」场景下**唯一**的唤醒路径
 * （Pub/Sub at-most-once：事件丢了，订阅就永不触发、永不回收）。
 * 契约：子 run 已终态 / 本 run 被巡检判 timeout → 订阅必须在同一处回收；
 *       子 run 仍在跑 / 条件更新竞争失败 → 绝不回收（订阅仍可能有效，绝不误删）。
 * 不变量：唤醒的事实源始终是 DB 条件更新（与本订阅无关）——回收绝不改变唤醒结果。
 */
function makeLease(rows: Array<Record<string, unknown>> = [], over: {
  child?: { status: string } | null;
  wokenCount?: number;
} = {}) {
  const added: Array<{ data: unknown; opts: Record<string, unknown> }> = [];
  const prisma = {
    systemSetting: { findUnique: vi.fn(async () => ({ key: 'limits', value: {} })) }, // value {} → deadline = 默认 1h
    workflowRun: {
      // M11-P7 D2-12：recoverStale 改为 deadline 下推 SQL + 游标分页两段扫描——
      // fake 必须忠实实现 where 过滤 + 排序 + cursor/take 分页（原替身无视参数全量返回，
      // 同一行会被两段扫描各扫一次 → reEnqueued 双计）
      findMany: vi.fn(async (args?: { where?: Record<string, unknown>; take?: number; cursor?: { id: string }; skip?: number }) => {
        const cond = (args?.where?.startedAt ?? {}) as { lt?: Date; gte?: Date };
        let filtered = rows.filter((r) => {
          const t = (r.startedAt as Date).getTime();
          if (cond.lt && !(t < cond.lt.getTime())) return false;
          if (cond.gte && !(t >= cond.gte.getTime())) return false;
          return true;
        });
        filtered = [...filtered].sort((a, b) =>
          (a.startedAt as Date).getTime() - (b.startedAt as Date).getTime() || String(a.id).localeCompare(String(b.id)));
        if (args?.cursor?.id) filtered = filtered.filter((r) => String(r.id) > String(args.cursor!.id));
        if (args?.take) filtered = filtered.slice(0, args.take);
        return filtered;
      }),
      updateMany: vi.fn(async () => ({ count: over.wokenCount ?? 1 })),
    },
    agentRun: { findUnique: vi.fn(async () => over.child ?? null) },
    approval: { findUnique: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 1 })) },
    workflowStepRun: { findUnique: vi.fn(async () => null) },
  };
  const queue = {
    name: 'workflow',
    add: vi.fn(async (_name: string, data: unknown, opts: Record<string, unknown>) => {
      added.push({ data, opts });
      return { id: 'job-1' };
    }),
  };
  const quota = { release: vi.fn(async () => undefined) };
  const wake = { clearChildSubscription: vi.fn() };
  const svc = new WorkflowLeaseService(prisma as never, queue as never, quota as never, wake as never);
  return { svc, prisma, queue, quota, wake, added };
}

const recent = () => new Date(Date.now() - 60_000); // 未超 deadline（默认 1h）

describe('WorkflowLeaseService.recoverStale（D2-04 兜底唤醒 + 子 run 订阅回收）', () => {
  beforeEach(() => vi.clearAllMocks());

  const waitingOnChild = {
    id: 'run-1', status: 'waiting', startedAt: recent(), workerId: null, leaseUntil: null,
    waitingOnApprovalId: null, waitingOnAgentRunId: 'child-1', currentStep: 2,
  };

  it('子 run 已终态（终态事件丢失）→ 兜底唤醒 **并回收该子 run 的订阅**（绝不常驻）', async () => {
    const { svc, prisma, added, wake } = makeLease([waitingOnChild], { child: { status: 'completed' } });
    const res = await svc.recoverStale();
    expect(res).toEqual({ reEnqueued: 1, timedOut: 0 });
    expect(wake.clearChildSubscription).toHaveBeenCalledWith('child-1');
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-1', status: 'waiting', waitingOnAgentRunId: 'child-1' },
      data: expect.objectContaining({ status: 'queued', waitingOnAgentRunId: null }),
    }));
    expect(added).toHaveLength(1); // 兜底唤醒投递照常（唯一 jobId）
  });

  it('子 run 仍在跑 → 不动（正常等待；订阅保留——此刻回收即丢唤醒）', async () => {
    const { svc, prisma, added, wake } = makeLease([waitingOnChild], { child: { status: 'running' } });
    const res = await svc.recoverStale();
    expect(res).toEqual({ reEnqueued: 0, timedOut: 0 });
    expect(wake.clearChildSubscription).not.toHaveBeenCalled();
    expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
    expect(added).toHaveLength(0);
  });

  it('条件更新竞争失败（count=0，已被其他路径唤醒）→ 不重复投递，但订阅照常回收（子 run 已终态 → 永不触发）', async () => {
    const { svc, added, wake } = makeLease([waitingOnChild], { child: { status: 'failed' }, wokenCount: 0 });
    const res = await svc.recoverStale();
    expect(res).toEqual({ reEnqueued: 0, timedOut: 0 });
    expect(added).toHaveLength(0);
    expect(wake.clearChildSubscription).toHaveBeenCalledWith('child-1');
  });

  it('run 超 deadline → timeout 终态（绝不再被唤醒）→ 订阅一并回收', async () => {
    const stale = { ...waitingOnChild, startedAt: new Date(Date.now() - 2 * 60 * 60_000) };
    const { svc, prisma, quota, wake } = makeLease([stale], { child: { status: 'running' } });
    const res = await svc.recoverStale();
    expect(res).toEqual({ reEnqueued: 0, timedOut: 1 });
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'timeout', waitingOnAgentRunId: null }),
    }));
    expect(quota.release).toHaveBeenCalledWith('run-1', 'workflow_run');
    expect(wake.clearChildSubscription).toHaveBeenCalledWith('child-1');
  });

  it('不变量：回收绝不改变唤醒语义——订阅早已丢失（未登记/已回收）时兜底唤醒照常生效', async () => {
    const { svc, wake } = makeLease([waitingOnChild], { child: { status: 'cancelled' } });
    wake.clearChildSubscription.mockClear(); // 模拟"本进程从未登记该订阅"（无 DB/总线依赖）
    const res = await svc.recoverStale();
    expect(res.reEnqueued).toBe(1); // 事实源 = DB 条件更新，与本订阅无关
  });
});
