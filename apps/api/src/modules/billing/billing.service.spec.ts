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
    invoice: {
      create: vi.fn().mockResolvedValue({ id: 'inv-1' }), update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([]),
    },
    paymentEvent: { create: vi.fn().mockResolvedValue({ id: 'pe-1' }), findUnique: vi.fn().mockResolvedValue({ id: 'pe-1' }) },
    project: { findFirst: vi.fn().mockResolvedValue({ organizationId: 'org-1' }) },
    // Pre-M9 G8：交互式事务（回调形式）——单测里以同一 mock 作为 tx 传入，断言"事件与发票同事务"
    $transaction: vi.fn(async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[]))),
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
    // G8：发票终态在支付事务内写入（open→paid）
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: expect.any(String), status: 'open' }, data: expect.objectContaining({ status: 'paid' }),
    }));

    // 重复支付事件：P2002 → duplicate:true（绝不重复入账），但必须补齐发票终态（G8 修复）
    (prisma.invoice.updateMany as ReturnType<typeof vi.fn>).mockClear();
    prisma.paymentEvent.create.mockRejectedValue({ code: 'P2002' });
    const dup = await svc.applyPayment('org-1', 'inv-1', 99);
    expect(dup).toMatchObject({ duplicate: true, paymentEventId: 'pe-1' });
    expect(prisma.paymentEvent.create).toHaveBeenCalledTimes(2); // 未新增持久化行（P2002 被拒）
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'inv-1', status: 'open' }, data: expect.objectContaining({ status: 'paid' }),
    }));
  });

  it('G8：支付事件与发票终态同事务（任一失败整体回滚，绝不留"已入账未付费"漂移）', async () => {
    const { svc, prisma } = makeService();
    const res = await svc.applyPayment('org-1', 'inv-1', 9.9);
    expect(res).toMatchObject({ duplicate: false, paymentEventId: 'pe-1' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1); // 两次写在同一事务回调内
    expect(prisma.paymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ providerEventId: 'mock-pay-inv-1-9.9', invoiceId: 'inv-1', type: 'payment.succeeded' }),
    }));

    // 发票不可支付（不存在/非 open）→ 抛错（事务回滚：事件不落库，重试可重入）
    prisma.invoice.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.applyPayment('org-1', 'inv-missing', 9.9)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('G8 崩溃重放：事件已落库但发票仍 open（非事务时代遗留）→ 重投幂等返回且发票被补齐', async () => {
    const { svc, prisma } = makeService();
    prisma.paymentEvent.create.mockRejectedValue({ code: 'P2002' }); // 事件已在库（崩溃后重放）
    prisma.paymentEvent.findUnique.mockResolvedValue({ id: 'pe-legacy' });
    const res = await svc.applyPayment('org-1', 'inv-1', 99);
    expect(res).toMatchObject({ duplicate: true, paymentEventId: 'pe-legacy' }); // 返回真实事件行 id
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'inv-1', status: 'open' }, data: expect.objectContaining({ status: 'paid' }),
    }));
  });

  it('G8：发票补齐失败（DB 抖动）不改变幂等结论，也绝不上抛（下次重投/对账可修复）', async () => {
    const { svc, prisma } = makeService();
    prisma.paymentEvent.create.mockRejectedValue({ code: 'P2002' });
    prisma.invoice.updateMany.mockRejectedValue(new Error('db down'));
    await expect(svc.applyPayment('org-1', 'inv-1', 99)).resolves.toMatchObject({ duplicate: true });
  });

  it('G8：非幂等类错误（DB 错误）必须上抛，绝不吞成 duplicate', async () => {
    const { svc, prisma } = makeService();
    prisma.paymentEvent.create.mockRejectedValue(Object.assign(new Error('connection lost'), { code: 'P1001' }));
    await expect(svc.applyPayment('org-1', 'inv-1', 99)).rejects.toThrow('connection lost');
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
