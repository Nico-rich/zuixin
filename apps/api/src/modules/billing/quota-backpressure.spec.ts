import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuotaService } from './quota.service';

/**
 * M8-P9 背压单测（全局队列深度 → 429）。
 * 队列为替身（不真投递 job）：验证"超水位拒绝 / 未超放行 / 不可观测时 fail-open"三条语义，
 * 以及它与 per-org 并发配额的分工（并发配额在超水位时不会被触及）。
 */

function makeService(queue: unknown) {
  const prisma = {
    usageLedgerEntry: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 0 } }) },
    agentRun: { count: vi.fn().mockResolvedValue(0) },
    workflowRun: { count: vi.fn().mockResolvedValue(0) },
    organization: { findFirst: vi.fn().mockResolvedValue({ ownerUserId: 'u1' }) },
  };
  const billing = {
    organizationFor: vi.fn().mockResolvedValue('org-1'),
    ensureSubscription: vi.fn().mockResolvedValue({
      planId: 'p', status: 'active',
      entitlements: { agentRunsMonthly: 1000, agentRunsDaily: 1000, concurrentAgentRuns: 100 },
    }),
  };
  const svc = new QuotaService(prisma as never, billing as never, { ensurePersonalOrganization: vi.fn() } as never, queue as never);
  return { svc, prisma };
}

describe('M8-P9 背压：队列深度水位（waiting + active）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('未超水位 → 放行，返回 depth/maxDepth 供审计', async () => {
    const queue = { getJobCounts: vi.fn().mockResolvedValue({ waiting: 3, active: 2 }) };
    const { svc } = makeService(queue);
    await expect(svc.assertQueueDepth()).resolves.toMatchObject({ depth: 5, maxDepth: 1_000 });
    expect(queue.getJobCounts).toHaveBeenCalledWith('waiting', 'active');
  });

  it('超水位（≥ maxDepth）→ QUOTA_EXCEEDED（HTTP 429）', async () => {
    const queue = { getJobCounts: vi.fn().mockResolvedValue({ waiting: 999, active: 1 }) };
    const { svc } = makeService(queue);
    await expect(svc.assertQueueDepth()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('水位可配置（AGENT_RUN_QUEUE_MAX_DEPTH）：设为 2 时等待 1 + 执行 1 即拒绝', async () => {
    const prev = process.env.AGENT_RUN_QUEUE_MAX_DEPTH;
    process.env.AGENT_RUN_QUEUE_MAX_DEPTH = '2';
    try {
      const queue = { getJobCounts: vi.fn().mockResolvedValue({ waiting: 1, active: 1 }) };
      const { svc } = makeService(queue);
      await expect(svc.assertQueueDepth()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    } finally {
      if (prev === undefined) delete process.env.AGENT_RUN_QUEUE_MAX_DEPTH;
      else process.env.AGENT_RUN_QUEUE_MAX_DEPTH = prev;
    }
  });

  it('队列未装配（@Optional 未注入）→ fail-open（skipped=queue-not-wired），绝不误拒', async () => {
    const { svc } = makeService(undefined);
    await expect(svc.assertQueueDepth()).resolves.toMatchObject({ skipped: 'queue-not-wired' });
  });

  it('Redis 不可达（getJobCounts reject）→ fail-open（skipped=queue-unavailable）', async () => {
    const queue = { getJobCounts: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) };
    const { svc } = makeService(queue);
    await expect(svc.assertQueueDepth()).resolves.toMatchObject({ skipped: 'queue-unavailable' });
  });

  it('Redis 挂起 → 1s 硬超时后 fail-open（绝不挂住请求路径）', async () => {
    const queue = { getJobCounts: vi.fn().mockReturnValue(new Promise(() => undefined)) };
    const { svc } = makeService(queue);
    const t0 = Date.now();
    await expect(svc.assertQueueDepth()).resolves.toMatchObject({ skipped: 'queue-unavailable' });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(3_000);
  }, 10_000);

  it('assertQuota(agent_run) 先做背压：超水位时直接 429，不再查 DB 配额（最便宜的检查优先）', async () => {
    const queue = { getJobCounts: vi.fn().mockResolvedValue({ waiting: 5_000, active: 0 }) };
    const { svc, prisma } = makeService(queue);
    await expect(svc.assertQuota('u1', null, 'agent_run', 1)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(prisma.usageLedgerEntry.aggregate).not.toHaveBeenCalled();
    expect(prisma.agentRun.count).not.toHaveBeenCalled();
  });

  it('assertQuota(workflow_run) 不受 agent-run 队列深度影响（队列边界不串味）', async () => {
    const queue = { getJobCounts: vi.fn().mockResolvedValue({ waiting: 5_000, active: 5_000 }) };
    const { svc } = makeService(queue);
    await expect(svc.assertQuota('u1', null, 'workflow_run', 1)).resolves.toMatchObject({ organizationId: 'org-1' });
    expect(queue.getJobCounts).not.toHaveBeenCalled();
  });
});
