import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunLeaseService } from './agent-run-lease.service';

/**
 * M11-P7 D2-11：recoverStale 改为「deadline 下推 SQL + 游标分页」两段查询。
 * 替身必须**忠实实现 where 过滤 + take + cursor**，否则两段查询/分页语义在单测里不可见
 * （原替身无视查询参数全部返回，会掩盖"下推条件写错 = 漏判/重复判"这类缺陷）。
 */
type Row = Record<string, unknown> & { id: string; status: string; startedAt: Date };

function matchesWhere(row: Row, where: Record<string, any>): boolean {
  const status = where.status;
  if (status && !(Array.isArray(status.in) ? status.in.includes(row.status) : status === row.status)) return false;
  const startedAt = where.startedAt;
  if (startedAt?.lt && !(row.startedAt.getTime() < (startedAt.lt as Date).getTime())) return false;
  if (startedAt?.gte && !(row.startedAt.getTime() >= (startedAt.gte as Date).getTime())) return false;
  return true;
}

/** 默认 findMany 行为：where 过滤 + (startedAt,id) 排序 + take + cursor 分页（与 Prisma 语义一致的最小实现） */
function pageQuery(rows: Row[], args: Record<string, any>): Row[] {
  const filtered = rows
    .filter((r) => matchesWhere(r, args.where ?? {}))
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));
  const cursorId = (args.cursor as { id: string } | undefined)?.id;
  const from = cursorId ? filtered.findIndex((r) => r.id === cursorId) + 1 : 0;
  const paged = filtered.slice(from < 0 ? filtered.length : from);
  return typeof args.take === 'number' ? paged.slice(0, args.take) : paged;
}

function makeService(rows: Row[] = []) {
  const queue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
  const prisma = {
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue({ key: 'limits', value: { agentRunLeaseTtlMs: 60000, agentRunDeadlineMs: 2400000, agentRunHeartbeatMs: 15000 } }),
    },
    agentRun: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn(async (args: Record<string, any>) => pageQuery(rows, args)),
    },
    approval: {
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  // M10 Final Audit H2c：构造注入 QuotaService（recoverStale 超时释放 C1 预留）
  const quota = { release: vi.fn().mockResolvedValue(undefined) };
  return { svc: new AgentRunLeaseService(prisma as never, queue as never, events as never, quota as never), prisma, queue, events, quota };
}

/** D2-11：查询参数（where/分页）断言用 */
function findManyArgs(prisma: { agentRun: { findMany: ReturnType<typeof vi.fn> } }) {
  return prisma.agentRun.findMany.mock.calls.map((c) => c[0] as Record<string, any>);
}

describe('AgentRunLeaseService（claim/renew/release + stale recovery）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('claim 成功：queued 未持有 → running + workerId + leaseUntil', async () => {
    const { svc, prisma } = makeService();
    const res = await svc.claim('run-1', 'worker-A', 60_000);
    expect(res.acquired).toBe(true);
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'run-1' }),
      data: expect.objectContaining({ status: 'running', workerId: 'worker-A', leaseUntil: expect.any(Date) }),
    }));
  });

  it('claim 失败（他 worker 持有且 lease 未过期）→ acquired=false 且带状态诊断', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    prisma.agentRun.findUnique.mockResolvedValue({ status: 'running', workerId: 'worker-B' });
    const res = await svc.claim('run-1', 'worker-A', 60_000);
    expect(res.acquired).toBe(false);
    expect(res).toMatchObject({ status: 'running', workerId: 'worker-B' });
  });

  it('stale takeover：running + lease 过期 → 新 worker 可 claim（崩溃恢复）', async () => {
    const { svc, prisma } = makeService();
    await svc.claim('run-1', 'worker-B', 60_000);
    const where = (prisma.agentRun.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    // running 分支：workerId 非空且 lease 过期/null 可接管；waiting/terminal/sync 不在分支
    expect(JSON.stringify(where)).toContain('running');
    expect(JSON.stringify(where)).not.toContain('waiting');
    expect(JSON.stringify(where)).not.toContain('completed');
  });

  it('terminal 不可 claim：updateMany where 只含 queued/running', async () => {
    const { svc, prisma } = makeService();
    await svc.claim('run-1', 'worker-A', 60_000);
    const where = (prisma.agentRun.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    const serialized = JSON.stringify(where);
    for (const terminal of ['completed', 'failed', 'cancelled', 'timeout', 'waiting']) {
      expect(serialized).not.toContain(`"status":"${terminal}"`);
    }
  });

  it('renew：只续自己持有的 lease（owner fencing）；count=0 ⇒ 调用方必须停止', async () => {
    const { svc, prisma } = makeService();
    await svc.renew('run-1', 'worker-A', 60_000);
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-1', workerId: 'worker-A', status: 'running' },
      data: expect.objectContaining({ heartbeatAt: expect.any(Date) }),
    }));
    prisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    const res = await svc.renew('run-1', 'worker-A', 60_000);
    expect(res.count).toBe(0); // fencing：已被接管
  });

  it('release：置 leaseUntil=null（新 worker 立即可接管；workerId 保留作记录）', async () => {
    const { svc, prisma } = makeService();
    await svc.release('run-1', 'worker-A');
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-1', workerId: 'worker-A', status: 'running' },
      data: { leaseUntil: null },
    }));
  });

  it('recoverStale：run deadline 已过 → timeout（queued/running 条件更新，不复活终态）', async () => {
    const { svc, prisma } = makeService([
      { id: 'run-old', status: 'running', workerId: 'w1', startedAt: new Date(Date.now() - 50 * 60_000), leaseUntil: new Date(Date.now() + 60_000) },
    ]);
    const res = await svc.recoverStale();
    expect(res.timedOut).toBe(1);
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-old', status: { in: ['queued', 'running', 'waiting'] } }, // M6-P4：waiting 同样受 deadline 约束
      data: expect.objectContaining({ status: 'timeout', errorCode: 'AGENT_RUN_TIMEOUT' }),
    }));
  });

  it('recoverStale：lease 过期但未超 deadline → 重新入队（lease 过期 ≠ run 超时）', async () => {
    const { svc, queue } = makeService([
      { id: 'run-stale', status: 'running', workerId: 'w1', startedAt: new Date(Date.now() - 60_000), leaseUntil: new Date(Date.now() - 1000) },
    ]);
    const res = await svc.recoverStale();
    expect(res).toMatchObject({ reEnqueued: 1, timedOut: 0 });
    expect(queue.add).toHaveBeenCalledWith('execute', { runId: 'run-stale' }, expect.objectContaining({ attempts: 2 }));
  });

  it('recoverStale：同步 run（workerId null）不在恢复域（sweepAgentRuns 120s 语义负责）', async () => {
    const { svc, queue } = makeService([
      { id: 'run-sync', status: 'running', workerId: null, startedAt: new Date(Date.now() - 60_000), leaseUntil: null },
    ]);
    const res = await svc.recoverStale();
    expect(res).toMatchObject({ reEnqueued: 0, timedOut: 0 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('recoverStale：lease 未过期 → 不重入队（正常执行中不触碰）', async () => {
    const { svc, queue } = makeService([
      { id: 'run-live', status: 'running', workerId: 'w1', startedAt: new Date(Date.now() - 60_000), leaseUntil: new Date(Date.now() + 30_000) },
    ]);
    const res = await svc.recoverStale();
    expect(res).toMatchObject({ reEnqueued: 0, timedOut: 0 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('M7-P1 recoverStale：waiting 且审批已终态（hook 丢失）→ 兜底唤醒', async () => {
    const { svc, queue, prisma } = makeService([
      { id: 'run-approve', status: 'waiting', workerId: null, startedAt: new Date(Date.now() - 60_000), leaseUntil: null, waitingOnTaskId: null, waitingOnApprovalId: 'a1' },
    ]);
    prisma.approval.findUnique.mockResolvedValue({ status: 'approved', expiresAt: null });
    const res = await svc.recoverStale();
    expect(res.reEnqueued).toBe(1);
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-approve', status: 'waiting', waitingOnApprovalId: 'a1' },
      data: expect.objectContaining({ status: 'queued', waitingOnApprovalId: null }),
    }));
    expect(queue.add).toHaveBeenCalledWith('execute', { runId: 'run-approve' }, expect.objectContaining({ attempts: 2 }));
  });

  it('M7-P1 recoverStale：waiting 且审批 requested 但已过期 → 先 expire 再唤醒', async () => {
    const { svc, queue, prisma } = makeService([
      { id: 'run-expire', status: 'waiting', workerId: null, startedAt: new Date(Date.now() - 60_000), leaseUntil: null, waitingOnTaskId: null, waitingOnApprovalId: 'a2' },
    ]);
    prisma.approval.findUnique.mockResolvedValue({ status: 'requested', expiresAt: new Date(Date.now() - 1000) });
    await svc.recoverStale();
    expect(prisma.approval.updateMany).toHaveBeenCalledWith({ where: { id: 'a2', status: 'requested' }, data: { status: 'expired' } });
    expect(queue.add).toHaveBeenCalled();
  });

  it('M7-P1 recoverStale：waiting 且审批仍未决未过期 → 不动（正常等待审批中）', async () => {
    const { svc, queue, prisma } = makeService([
      { id: 'run-wait', status: 'waiting', workerId: null, startedAt: new Date(Date.now() - 60_000), leaseUntil: null, waitingOnTaskId: null, waitingOnApprovalId: 'a3' },
    ]);
    prisma.approval.findUnique.mockResolvedValue({ status: 'requested', expiresAt: new Date(Date.now() + 60_000) });
    const res = await svc.recoverStale();
    expect(res).toMatchObject({ reEnqueued: 0, timedOut: 0 });
    expect(queue.add).not.toHaveBeenCalled();
  });
});

/**
 * M11-P7 D2-11：无界载入治理。
 * 契约：① deadline 判定下推 SQL（两段条件互斥、等价于原逐行判定——绝不漏判/误判）；
 *      ② 单批 take 上限 + 游标分页（不再一次性载入全部活跃行）；③ 单周期批数有界（绝不无限循环）。
 */
describe('M11-P7 D2-11：recoverStale 下推 + 分页（无界载入治理）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deadline 判定下推 SQL：超期行只在「startedAt < now-deadline」段，未超期段绝不重复处理', async () => {
    const expired = { id: 'run-expired', status: 'running', workerId: 'w1', startedAt: new Date(Date.now() - 50 * 60_000), leaseUntil: new Date(Date.now() + 60_000) };
    const fresh = { id: 'run-fresh', status: 'running', workerId: 'w1', startedAt: new Date(Date.now() - 60_000), leaseUntil: new Date(Date.now() - 1_000) };
    const { svc, prisma } = makeService([expired, fresh]);
    const res = await svc.recoverStale();
    // 两段条件互斥且覆盖全部活跃行：超期段 + 未超期段各一次
    const args = findManyArgs(prisma);
    expect(args).toHaveLength(2);
    expect(args[0].where).toMatchObject({ status: { in: ['queued', 'running', 'waiting'] }, startedAt: { lt: expect.any(Date) } });
    expect(args[1].where).toMatchObject({ status: { in: ['queued', 'running', 'waiting'] }, startedAt: { gte: expect.any(Date) } });
    // 下推判定与逐行判定等价：超期 → timeout；未超期（lease 过期）→ 重入队
    expect(res).toMatchObject({ timedOut: 1, reEnqueued: 1 });
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-expired', status: { in: ['queued', 'running', 'waiting'] } },
      data: expect.objectContaining({ status: 'timeout' }),
    }));
  });

  it('分页：单批 take 上限 + 游标推进——超出一批的活跃行分多批处理，绝不一次载入全表', async () => {
    const now = Date.now();
    // 250 个未超期但 lease 过期的 run（> 单批上限 200 → 必须分 2 批）
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `run-${String(i).padStart(3, '0')}`, status: 'running', workerId: 'w1',
      startedAt: new Date(now - 60_000), leaseUntil: new Date(now - 1_000),
    }));
    const { svc, prisma, queue } = makeService(rows);
    const res = await svc.recoverStale();
    expect(res.reEnqueued).toBe(250); // 全部行都被处理（分页绝不漏行）
    const args = findManyArgs(prisma);
    expect(args).toHaveLength(3); // 超期段 1 次（空）+ 未超期段 2 批
    expect(args[0].take).toBe(200); // 单批上限（非全量载入）
    expect(args[1].take).toBe(200);
    expect(args[1].cursor).toBeUndefined(); // 首批无游标
    expect(args[2].cursor).toEqual({ id: 'run-199' }); // 后续批游标 = 上一批最后一行
    expect(args[2].skip).toBe(1); // 跳过游标行本身（绝不重复处理）
    expect(queue.add).toHaveBeenCalledTimes(250);
  });

  it('单周期批数有界：数据面持续满批时也绝不无限循环（达到上限即交由下个周期）', async () => {
    const now = Date.now();
    let call = 0;
    const { svc, prisma, queue } = makeService([]);
    // 替身：每批都返回满批（模拟"永远有下一批"）；id 递增 → 游标持续前进，只能靠批数上限收敛
    prisma.agentRun.findMany.mockImplementation(async (args: Record<string, any>) => {
      call++;
      if (args.where?.startedAt?.lt) return []; // 超期段：空（本用例只压未超期段的分页上限）
      return Array.from({ length: 200 }, (_, i) => ({
        id: `run-${call}-${String(i).padStart(3, '0')}`, status: 'running', workerId: null, // 同步 run：逐行分支无副作用
        startedAt: new Date(now - 60_000), leaseUntil: null,
      }));
    });
    const res = await svc.recoverStale();
    // 1 次（超期段）+ 10 次（未超期段达到批数上限 RECOVER_MAX_BATCHES=10 后停止）
    expect(prisma.agentRun.findMany).toHaveBeenCalledTimes(11);
    expect(call).toBe(11);
    expect(res).toMatchObject({ reEnqueued: 0, timedOut: 0 });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
