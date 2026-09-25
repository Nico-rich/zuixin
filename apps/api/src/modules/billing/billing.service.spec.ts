import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BillingService } from './billing.service';

function makeService() {
  const prisma = {
    plan: {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ id: 'plan-free', code: 'free', entitlements: { agentRunsMonthly: 100 } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    subscription: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      upsert: vi.fn(),
    },
    usageLedgerEntry: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 0 } }),
    },
    invoice: { create: vi.fn().mockResolvedValue({ id: 'inv-1' }), update: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    paymentEvent: { create: vi.fn().mockResolvedValue({ id: 'pe-1' }) },
    project: { findFirst: vi.fn().mockResolvedValue({ organizationId: 'org-1' }) },
  };
  const orgs = { ensurePersonalOrganization: vi.fn().mockResolvedValue({ id: 'org-personal' }) };
  const svc = new BillingService(prisma as never, orgs as never);
  return { svc, prisma };
}

describe('BillingService（M8-P2 计划/订阅/计量/支付）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ensureSubscription：缺省 free；已有订阅按状态取有效计划（非 active → free 额度）', async () => {
    const { svc, prisma } = makeService();
    const res = await svc.ensureSubscription('org-1');
    expect(res).toMatchObject({ planId: 'plan-free', status: 'active' });
    prisma.subscription.findUnique.mockResolvedValue({
      id: 's1', status: 'cancelled',
      plan: { id: 'plan-pro', code: 'pro', entitlements: { seats: 5 } },
    });
    const res2 = await svc.ensureSubscription('org-1');
    expect(res2.planId).toBe('plan-free'); // cancelled → 免费额度语义
  });

  it('recordUsage：入账 + 组织归属（项目组织 > 个人组织）；P2002 重复键幂等（绝不重复计量）', async () => {
    const { svc, prisma } = makeService();
    await svc.recordUsage({ userId: 'u1', projectId: 'p1', kind: 'agent_run', quantity: 1, idempotencyKey: 'k1' });
    expect(prisma.usageLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: 'org-1', kind: 'agent_run', idempotencyKey: 'k1' }),
    }));
    prisma.usageLedgerEntry.create.mockRejectedValue({ code: 'P2002' });
    await expect(svc.recordUsage({ userId: 'u1', kind: 'agent_run', idempotencyKey: 'k1' })).resolves.toBeUndefined(); // 幂等
  });

  it('subscribe：upsert 订阅 + 开票 + 支付事件；重复支付事件幂等（绝不重复入账）', async () => {
    const { svc, prisma } = makeService();
    prisma.plan.findUnique.mockResolvedValue({ id: 'plan-pro', code: 'pro', monthlyPrice: 99, entitlements: { seats: 5 }, active: true });
    prisma.subscription.upsert.mockResolvedValue({ id: 's1', plan: { code: 'pro' } });
    const res = await svc.subscribe('u1', 'org-1', 'plan-pro');
    expect(res).toMatchObject({ plan: 'pro', status: 'active', entitlements: { seats: 5 } });
    expect(prisma.paymentEvent.create).toHaveBeenCalledTimes(1);

    // 重复支付事件：P2002 → duplicate:true（绝不重复入账）
    (prisma.invoice.update as ReturnType<typeof vi.fn>).mockClear(); // 清空 subscribe 流程的 paid 更新
    prisma.paymentEvent.create.mockRejectedValue({ code: 'P2002' });
    const dup = await svc.applyPayment('org-1', 'inv-1', 99);
    expect(dup.duplicate).toBe(true);
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it('usage：ledger 聚合 facts + derived 分层', async () => {
    const { svc, prisma } = makeService();
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      { kind: 'agent_run', quantity: 3 }, { kind: 'llm_tokens', quantity: 5000 }, { kind: 'llm_cost', quantity: 0.12 },
    ]);
    const res = await svc.usage('org-1');
    expect(res.facts).toMatchObject({ agent_run: 3, llm_tokens: 5000, llm_cost: 0.12 });
    expect(res.layering).toMatchObject({ facts: 'ledger-aggregate', derived: 'service-computed' });
  });

  it('organizationFor：项目组织优先；无项目 → 个人组织', async () => {
    const { svc, prisma } = makeService();
    expect(await svc.organizationFor('u1', 'p1')).toBe('org-1');
    prisma.project.findFirst.mockResolvedValue(null);
    expect(await svc.organizationFor('u1', null)).toBe('org-personal');
  });
});
