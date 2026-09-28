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

const mirror = (over: Record<string, unknown> = {}) => ({
  id: 'l1', kind: 'llm_tokens', quantity: 1500, usageRecordId: 'ur-1',
  idempotencyKey: 'ur:ur-1:llm_tokens', ...over,
});

/** ledger-only 行（usageRecordId 为空——无 UsageRecord 事实源） */
const ledgerOnlyRow = (over: Record<string, unknown> = {}) => ({
  id: 'lo-1', kind: 'agent_run', quantity: 1, usageRecordId: null,
  idempotencyKey: 'run:r1:agent-run', ...over,
});

describe('BillingReconciliationService（Pre-M9 D1：UsageRecord ↔ 账本镜像对账）', () => {
  it('完全一致：每条记录每种 kind 恰好一行镜像且数量相等 → consistent', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([
      record({ id: 'ur-1', kind: 'image', inputTokens: 0, outputTokens: 0, imageCount: 3, estimatedCost: 0.45 }),
      record({ id: 'ur-2' }),
    ]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      { id: 'l1', kind: 'image_generation', quantity: 3, usageRecordId: 'ur-1', idempotencyKey: 'ur:ur-1:image_generation' },
      { id: 'l2', kind: 'llm_tokens', quantity: 1500, usageRecordId: 'ur-2', idempotencyKey: 'ur:ur-2:llm_tokens' },
      { id: 'l3', kind: 'llm_cost', quantity: 0.005, usageRecordId: 'ur-2', idempotencyKey: 'ur:ur-2:llm_cost' },
    ]);
    const res = await svc.diagnose('org-1', '2026-09');
    expect(res.consistent).toBe(true);
    expect(res.missing).toEqual([]);
    expect(res.duplicates).toEqual([]);
    expect(res.wrongAmount).toEqual([]);
    expect(res.ledgerOnly).toMatchObject({ rows: 0, duplicateKeys: [], nonPositive: [] });
  });

  it('发现 missing：有记录但缺对应镜像行', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([record({ id: 'ur-1' })]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      mirror({ id: 'l1' }),
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
      mirror({ id: 'l1', quantity: 1000 }),
      mirror({ id: 'l2', quantity: 500 }),
      mirror({ id: 'l3', kind: 'llm_cost', quantity: 0.005, idempotencyKey: 'ur:ur-1:llm_cost' }),
    ]);
    const res = await svc.diagnose('org-1', '2026-09');
    expect(res.duplicates).toEqual([expect.objectContaining({ usageRecordId: 'ur-1', kind: 'llm_tokens', actual: 2 })]);
    expect(res.consistent).toBe(false);
  });

  it('发现 wrongAmount：镜像数量与事实不符', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([record({ id: 'ur-1' })]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      mirror({ id: 'l1', quantity: 999 }), // 应为 1500
      mirror({ id: 'l2', kind: 'llm_cost', quantity: 0.005, idempotencyKey: 'ur:ur-1:llm_cost' }),
    ]);
    const res = await svc.diagnose('org-1', '2026-09');
    expect(res.wrongAmount).toEqual([expect.objectContaining({ usageRecordId: 'ur-1', kind: 'llm_tokens', expected: 1500, actual: 999 })]);
  });

  it('发现 orphan：账本行指向不存在的记录', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([record({ id: 'ur-1' })]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      mirror({ id: 'l1' }),
      mirror({ id: 'l2', kind: 'llm_cost', quantity: 0.005, idempotencyKey: 'ur:ur-1:llm_cost' }),
      mirror({ id: 'l3', quantity: 100, usageRecordId: 'ur-gone', idempotencyKey: 'ur:ur-gone:llm_tokens' }), // 指向已删记录
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

  it('period 月份越界（2026-13 / 2026-00）→ VALIDATION_ERROR（绝不落到 Invalid Date 查询）', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.diagnose('org-1', '2026-13')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.diagnose('org-1', '2026-00')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.usageRecord.findMany).not.toHaveBeenCalled();
  });
});

describe('M11 P3（D1-08）：ledger-only 独立校验段', () => {
  it('ledger-only 行纳入报告（agent_run/workflow_run/external_api_call/attachment_upload）且零违例 → consistent', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([record({ id: 'ur-1' })]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      mirror({ id: 'l1' }),
      mirror({ id: 'l2', kind: 'llm_cost', quantity: 0.005, idempotencyKey: 'ur:ur-1:llm_cost' }),
      ledgerOnlyRow({ id: 'lo-1', kind: 'agent_run', idempotencyKey: 'run:r1:agent-run' }),
      ledgerOnlyRow({ id: 'lo-2', kind: 'workflow_run', idempotencyKey: 'wf:w1:workflow-run' }),
      ledgerOnlyRow({ id: 'lo-3', kind: 'external_api_call', idempotencyKey: 'ea:a1' }),
      ledgerOnlyRow({ id: 'lo-4', kind: 'attachment_upload', idempotencyKey: 'att:t1' }),
      ledgerOnlyRow({ id: 'lo-5', kind: 'storage', quantity: 7, idempotencyKey: 'st:1' }),
    ]);
    const res = await svc.diagnose('org-1', '2026-09');
    // 原实现整类过滤：mirrorRows 只数到 2，ledger-only 行在报告里完全不可见
    expect(res.ledgerOnly.rows).toBe(5);
    expect(res.ledgerOnly.kinds).toMatchObject({
      agent_run: { rows: 1, quantity: 1 },
      workflow_run: { rows: 1, quantity: 1 },
      external_api_call: { rows: 1, quantity: 1 },
      attachment_upload: { rows: 1, quantity: 1 },
      storage: { rows: 1, quantity: 7 },
    });
    expect(res.ledgerOnly.duplicateKeys).toEqual([]);
    expect(res.ledgerOnly.nonPositive).toEqual([]);
    expect(res.unlinked).toEqual([]);
    expect(res.consistent).toBe(true);
  });

  it('幂等键重复（同键多行）→ duplicateKeys 违例 + consistent=false（结构性重复计量）', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      ledgerOnlyRow({ id: 'lo-1', kind: 'attachment_upload', idempotencyKey: 'att:t1' }),
      ledgerOnlyRow({ id: 'lo-2', kind: 'attachment_upload', idempotencyKey: 'att:t1' }),
    ]);
    const res = await svc.diagnose('org-1', '2026-09');
    expect(res.ledgerOnly.duplicateKeys).toEqual([
      expect.objectContaining({ idempotencyKey: 'att:t1', kind: 'attachment_upload', count: 2 }),
    ]);
    expect(res.consistent).toBe(false);
  });

  it('数量口径：quantity ≤ 0 的 ledger-only 行 → nonPositive 违例 + consistent=false', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      ledgerOnlyRow({ id: 'lo-zero', kind: 'agent_run', quantity: 0, idempotencyKey: 'run:r0:agent-run' }),
      ledgerOnlyRow({ id: 'lo-neg', kind: 'agent_run', quantity: -1, idempotencyKey: 'run:r-1:agent-run' }),
    ]);
    const res = await svc.diagnose('org-1', '2026-09');
    expect(res.ledgerOnly.nonPositive).toEqual([
      expect.objectContaining({ ledgerId: 'lo-zero', kind: 'agent_run', quantity: 0 }),
      expect.objectContaining({ ledgerId: 'lo-neg', kind: 'agent_run', quantity: -1 }),
    ]);
    expect(res.consistent).toBe(false);
  });

  it('同源盲区：镜像 kind 却无 usageRecordId（断链）→ unlinked 违例（既不属 missing 也不属 orphan）', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      ledgerOnlyRow({ id: 'l-broken', kind: 'llm_tokens', quantity: 100, idempotencyKey: 'legacy:l1' }),
    ]);
    const res = await svc.diagnose('org-1', '2026-09');
    expect(res.unlinked).toEqual([
      { ledgerId: 'l-broken', kind: 'llm_tokens', idempotencyKey: 'legacy:l1' },
    ]);
    expect(res.ledgerOnly.rows).toBe(0); // 断链镜像行不混入 ledger-only 段
    expect(res.consistent).toBe(false);
  });
});

describe('M11 P3（D2-15）：records/ledger 同界 [当月首日, 下月首日)', () => {
  it('历史月：两侧窗口都用该月首日与下月首日（原来 records 无上界 / ledger 无界全量）', async () => {
    const { svc, prisma } = makeService();
    const res = await svc.diagnose('org-1', '2026-01');
    expect(res.period).toBe('2026-01');
    const window = { gte: new Date('2026-01-01T00:00:00.000Z'), lt: new Date('2026-02-01T00:00:00.000Z') };
    expect(prisma.usageRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organizationId: 'org-1', createdAt: window }),
    }));
    expect(prisma.usageLedgerEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organizationId: 'org-1', createdAt: window }),
    }));
  });

  it('当月（12 月）：上界为次年 01-01 且与 records 同界（不再用 new Date() 截断）', async () => {
    const { svc, prisma } = makeService();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-12-15T08:00:00.000Z'));
      const res = await svc.diagnose('org-1'); // 缺省 = 当前 UTC 月
      expect(res.period).toBe('2026-12');
      const window = { gte: new Date('2026-12-01T00:00:00.000Z'), lt: new Date('2027-01-01T00:00:00.000Z') };
      expect(prisma.usageRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ createdAt: window }),
      }));
      expect(prisma.usageLedgerEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ createdAt: window }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('历史月结论只由该月数据决定：ledger 无界扫描会掺入的当期行不再计入', async () => {
    const { svc, prisma } = makeService();
    // mock 按窗口返回：历史月 1 条事实 + 1 条镜像；当期 ledger-only 行不会出现在历史月报告里
    prisma.usageRecord.findMany.mockResolvedValue([
      record({ id: 'ur-hist', createdAt: new Date('2026-01-10T00:00:00.000Z') }),
    ]);
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      mirror({ id: 'l-hist-1', usageRecordId: 'ur-hist', idempotencyKey: 'ur:ur-hist:llm_tokens' }),
      mirror({ id: 'l-hist-2', kind: 'llm_cost', quantity: 0.005, usageRecordId: 'ur-hist', idempotencyKey: 'ur:ur-hist:llm_cost' }),
    ]);
    const res = await svc.diagnose('org-1', '2026-01');
    expect(res.records).toBe(1);
    expect(res.ledgerOnly.rows).toBe(0);
    expect(res.consistent).toBe(true);
  });
});
