import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuotaService } from './quota.service';
import { AppError } from '../../common/errors/app-error';

function makeService() {
  const prisma = {
    usageLedgerEntry: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 0 } }),
    },
    quotaReservation: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 0 } }),
      create: vi.fn().mockResolvedValue({ id: 'res-1' }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    agentRun: { count: vi.fn().mockResolvedValue(0) },
    workflowRun: { count: vi.fn().mockResolvedValue(0) },
    organization: { findFirst: vi.fn().mockResolvedValue({ ownerUserId: 'u1' }) },
  };
  const billing = {
    organizationFor: vi.fn().mockResolvedValue('org-1'),
    ensureSubscription: vi.fn().mockResolvedValue({
      planId: 'plan-free', status: 'active',
      entitlements: { agentRunsMonthly: 10, agentRunsDaily: 5, concurrentAgentRuns: 2, workflowRunsMonthly: 10, concurrentWorkflowRuns: 2, llmTokensMonthly: 1000 },
    }),
  };
  const orgs = { ensurePersonalOrganization: vi.fn() };
  const svc = new QuotaService(prisma as never, billing as never, orgs as never);
  return { svc, prisma, billing };
}

describe('QuotaService（M8-P2 月度/每日/并发三态；服务端裁决）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('月度配额：consumed+quantity > monthly → QUOTA_EXCEEDED', async () => {
    const { svc, prisma } = makeService();
    prisma.usageLedgerEntry.aggregate.mockResolvedValue({ _sum: { quantity: 10 } });
    await expect(svc.assertQuota('u1', null, 'agent_run', 1)).rejects.toBeInstanceOf(AppError);
    await expect(svc.assertQuota('u1', null, 'agent_run', 1)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('每日配额：当日聚合超 daily → QUOTA_EXCEEDED', async () => {
    const { svc, prisma } = makeService();
    prisma.usageLedgerEntry.aggregate
      .mockResolvedValueOnce({ _sum: { quantity: 1 } })  // monthly 查询（不超）
      .mockResolvedValueOnce({ _sum: { quantity: 5 } }); // daily 查询（=5 超限）
    await expect(svc.assertQuota('u1', null, 'agent_run', 1)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('并发配额：活跃 run ≥ concurrent → QUOTA_EXCEEDED', async () => {
    const { svc, prisma } = makeService();
    prisma.usageLedgerEntry.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });
    prisma.agentRun.count.mockResolvedValue(2); // = concurrentAgentRuns
    await expect(svc.assertQuota('u1', null, 'agent_run', 1)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
  it('M10 集成修复：concurrent 超限时预留行必须回滚（refId 预留先落库再检查）', async () => {
    const { svc, prisma } = makeService();
    prisma.usageLedgerEntry.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });
    prisma.agentRun.count.mockResolvedValue(2); // concurrent 超限
    prisma.quotaReservation.create.mockResolvedValue({ id: 'res-new' });
    await expect(svc.assertQuota('u1', null, 'agent_run', 1, 'run-x')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(prisma.quotaReservation.deleteMany).toHaveBeenCalledWith({ where: { id: 'res-new' } });
  });

  it('并发 WorkflowRun：活跃 ≥ concurrentWorkflowRuns → QUOTA_EXCEEDED', async () => {
    const { svc, prisma } = makeService();
    prisma.workflowRun.count.mockResolvedValue(2);
    await expect(svc.assertQuota('u1', null, 'workflow_run', 1)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('未超限：放行（返回组织与限额）', async () => {
    const { svc, prisma } = makeService();
    prisma.usageLedgerEntry.aggregate.mockResolvedValue({ _sum: { quantity: 3 } });
    prisma.agentRun.count.mockResolvedValue(0);
    const res = await svc.assertQuota('u1', null, 'agent_run', 1);
    expect(res.organizationId).toBe('org-1');
    expect(res.total).toBe(10);
  });

  it('entitlement 缺失 → 不限（计划未定义配额语义）', async () => {
    const { svc, billing } = makeService();
    billing.ensureSubscription.mockResolvedValue({ planId: 'p', status: 'active', entitlements: {} });
    await expect(svc.assertQuota('u1', null, 'storage', 1)).resolves.toMatchObject({ organizationId: 'org-1' });
  });

  it('Pre-M9 C1：refId 给定时创建预留行（expiresAt 为 TTL 后）', async () => {
    const { svc, prisma } = makeService();
    const res = await svc.assertQuota('u1', null, 'agent_run', 1, 'run-1');
    expect(prisma.quotaReservation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: 'org-1', kind: 'agent_run', refId: 'run-1', quantity: 1 }),
    }));
    expect(res.reservationId).toBe('res-1');
  });

  it('Pre-M9 C1：未过期预留计入消耗（reserved+consumed+quantity 超限 → 拒绝）', async () => {
    const { svc, prisma } = makeService();
    prisma.quotaReservation.aggregate.mockResolvedValue({ _sum: { quantity: 9 } }); // 账本 0 + 预留 9
    prisma.usageLedgerEntry.aggregate.mockResolvedValue({ _sum: { quantity: 2 } });  // 2+9+1 > 10
    await expect(svc.assertQuota('u1', null, 'agent_run', 1, 'run-1')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('Pre-M9 C1：release 删除预留（幂等）', async () => {
    const { svc, prisma } = makeService();
    await svc.release('run-1', 'agent_run');
    expect(prisma.quotaReservation.deleteMany).toHaveBeenCalledWith({ where: { refId: 'run-1', kind: 'agent_run' } });
  });

  it('Pre-M9 C1：并发同键预留 P2002 → 复用已有行', async () => {
    const { svc, prisma } = makeService();
    prisma.quotaReservation.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.quotaReservation.findUnique.mockResolvedValue({ id: 'res-existing' });
    const res = await svc.assertQuota('u1', null, 'agent_run', 1, 'run-1');
    expect(res.reservationId).toBe('res-existing');
  });
});
