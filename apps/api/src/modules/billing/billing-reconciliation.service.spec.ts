import { describe, it, expect, vi } from 'vitest';
import { BillingReconciliationService } from './billing-reconciliation.service';

function makeService() {
  const prisma = {
    usageRecord: { findMany: vi.fn().mockResolvedValue([]) },
    usageLedgerEntry: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const svc = new BillingReconciliationService(prisma as never);
  return { svc, prisma };
}

const record = (over: Record<string, unknown> = {}) => ({
  id: 'ur-1', kind: 'llm_chat', inputTokens: 1000, outputTokens: 500,
  estimatedCost: 0.005, imageCount: 0, videoSeconds: 0, createdAt: new Date(),
  ...over,
});

describe('BillingReconciliationService（Pre-M9 D1：UsageRecord ↔ 账本镜像对账）', () => {
  it('完全一致：每条记录每种 kind 恰好一行镜像且数量相等 → consistent', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([
      record({ id: 'ur-1', kind: 'image', inputTokens: 0, outputTokens: 0, imageCount: 3, estimatedCost: 0.45 }),
      record({ id: 'ur-2' }),
    ]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      { id: 'l1', kind: 'image_generation', quantity: 3, usageRecordId: 'ur-1' },
      { id: 'l2', kind: 'llm_tokens', quantity: 1500, usageRecordId: 'ur-2' },
      { id: 'l3', kind: 'llm_cost', quantity: 0.005, usageRecordId: 'ur-2' },
    ]);
    const res = await svc.diagnose('org-1', '2026-09');
    expect(res.consistent).toBe(true);
    expect(res.missing).toEqual([]);
    expect(res.duplicates).toEqual([]);
    expect(res.wrongAmount).toEqual([]);
  });

  it('发现 missing：有记录但缺对应镜像行', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([record({ id: 'ur-1' })]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      { id: 'l1', kind: 'llm_tokens', quantity: 1500, usageRecordId: 'ur-1' },
      // llm_cost 缺失
    ]);
    const res = await svc.diagnose('org-1', '2026-09');
    expect(res.consistent).toBe(false);
    expect(res.missing).toEqual([expect.objectContaining({ usageRecordId: 'ur-1', kind: 'llm_cost', expected: 0.005, actual: 0 })]);
  });

  it('发现 duplicate：同 (record, kind) 多行', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([record({ id: 'ur-1' })]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      { id: 'l1', kind: 'llm_tokens', quantity: 1000, usageRecordId: 'ur-1' },
      { id: 'l2', kind: 'llm_tokens', quantity: 500, usageRecordId: 'ur-1' },
      { id: 'l3', kind: 'llm_cost', quantity: 0.005, usageRecordId: 'ur-1' },
    ]);
    const res = await svc.diagnose('org-1', '2026-09');
    expect(res.duplicates).toEqual([expect.objectContaining({ usageRecordId: 'ur-1', kind: 'llm_tokens', actual: 2 })]);
    expect(res.consistent).toBe(false);
  });

  it('发现 wrongAmount：镜像数量与事实不符', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([record({ id: 'ur-1' })]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      { id: 'l1', kind: 'llm_tokens', quantity: 999, usageRecordId: 'ur-1' }, // 应为 1500
      { id: 'l2', kind: 'llm_cost', quantity: 0.005, usageRecordId: 'ur-1' },
    ]);
    const res = await svc.diagnose('org-1', '2026-09');
    expect(res.wrongAmount).toEqual([expect.objectContaining({ usageRecordId: 'ur-1', kind: 'llm_tokens', expected: 1500, actual: 999 })]);
  });

  it('发现 orphan：账本行指向不存在的记录', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([record({ id: 'ur-1' })]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      { id: 'l1', kind: 'llm_tokens', quantity: 1500, usageRecordId: 'ur-1' },
      { id: 'l2', kind: 'llm_cost', quantity: 0.005, usageRecordId: 'ur-1' },
      { id: 'l3', kind: 'llm_tokens', quantity: 100, usageRecordId: 'ur-gone' }, // 指向已删记录
    ]);
    const res = await svc.diagnose('org-1', '2026-09');
    expect(res.orphans).toEqual([expect.objectContaining({ ledgerId: 'l3', usageRecordId: 'ur-gone' })]);
    expect(res.consistent).toBe(false);
  });

  it('零量记录（失败回合）缺镜像不算漂移', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([
      record({ id: 'ur-1', inputTokens: 0, outputTokens: 0, estimatedCost: 0 }),
    ]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([]);
    const res = await svc.diagnose('org-1', '2026-09');
    expect(res.missing).toEqual([]);
    expect(res.consistent).toBe(true);
  });

  it('period 格式非法 → VALIDATION_ERROR', async () => {
    const { svc } = makeService();
    await expect(svc.diagnose('org-1', '2026/09')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
