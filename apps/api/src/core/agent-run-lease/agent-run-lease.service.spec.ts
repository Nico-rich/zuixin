import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunLeaseService } from './agent-run-lease.service';

function makeService(rows: Array<Record<string, unknown>> = []) {
  const queue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
  const prisma = {
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue({ key: 'limits', value: { agentRunLeaseTtlMs: 60000, agentRunDeadlineMs: 2400000, agentRunHeartbeatMs: 15000 } }),
    },
    agentRun: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue(rows),
    },
  };
  return { svc: new AgentRunLeaseService(prisma as never, queue as never), prisma, queue };
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
      where: { id: 'run-old', status: { in: ['queued', 'running'] } },
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
});
