import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommerceService } from './commerce.service';

function makeService(adapterOverrides: Record<string, unknown> = {}) {
  const adapter = {
    name: 'mock',
    listProducts: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    getProduct: vi.fn().mockResolvedValue(null),
    listOrders: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    traffic: vi.fn().mockResolvedValue([]),
    conversions: vi.fn().mockResolvedValue([]),
    listCampaigns: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    adMetrics: vi.fn().mockResolvedValue([]),
    revenue: vi.fn().mockResolvedValue([]),
    inventory: vi.fn().mockResolvedValue([]),
    ...adapterOverrides,
  };
  const prisma = {
    connection: { findFirst: vi.fn().mockResolvedValue({ id: 'c1', status: 'active', provider: 'mock' }) },
  };
  return { svc: new CommerceService(adapter as never, prisma as never), adapter, prisma };
}

const row = (start: Date, extra: Record<string, unknown>) => ({ periodStart: start, periodEnd: start, dimensionValue: 'all', ...extra });

describe('CommerceService（M7-P4 只读查询层 + facts/derived 分层）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolveTimeRange：days 缺省 30；start≥end → VALIDATION_ERROR；跨度>92 天 → VALIDATION_ERROR', () => {
    const { svc } = makeService();
    const r = svc.resolveTimeRange();
    expect(Math.round((r.end.getTime() - r.start.getTime()) / 86400_000)).toBe(30);
    expect(() => svc.resolveTimeRange({ start: '2026-09-24', end: '2026-09-24' })).toThrowError(/非法/);
    expect(() => svc.resolveTimeRange({ start: '2026-01-01', end: '2026-12-31' })).toThrowError(/跨度/);
  });

  it('productsList：facts 透传适配器分页 + readOnly 元信息', async () => {
    const { svc, adapter } = makeService({
      listProducts: vi.fn().mockResolvedValue({ items: [{ id: 'p1', title: '主图T恤' }], total: 1, page: 1, pageSize: 20 }),
    });
    const res = await svc.productsList('u1', {});
    expect(res).toMatchObject({ facts: { items: [{ id: 'p1' }], total: 1 }, meta: { provider: 'mock', readOnly: true } });
    expect(adapter.listProducts).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', connectionId: 'c1' }), expect.objectContaining({ page: 1 }));
  });

  it('ordersSummary：facts 原始聚合（取消/退款不计入）+ derived aov', async () => {
    const { svc, adapter } = makeService({
      listOrders: vi.fn().mockResolvedValue({
        items: [
          { status: 'paid', totalAmount: 100 }, { status: 'fulfilled', totalAmount: 300 },
          { status: 'cancelled', totalAmount: 50 }, { status: 'refunded', totalAmount: 20 },
        ],
        total: 4, page: 1, pageSize: 20,
      }),
    });
    const res = await svc.ordersSummary('u1', { timeRange: { days: 7 } });
    expect(res.facts).toMatchObject({ orderCount: 4, validOrderCount: 2, revenue: 400 });
    expect(res.derived).toMatchObject({ aov: 200 });
    expect(adapter.listOrders).toHaveBeenCalled();
  });

  it('adsPerformance：derived ctr/cvr/roas/cpc 由 facts 服务端计算，绝不混入 LLM 推测', async () => {
    const { svc, adapter } = makeService({
      listCampaigns: vi.fn().mockResolvedValue({ items: [{ id: 'c1', name: '夏季主推' }], total: 1, page: 1, pageSize: 20 }),
      adMetrics: vi.fn().mockResolvedValue([
        { periodStart: new Date(), periodEnd: new Date(), campaignId: 'c1', adId: null, impressions: 1000, clicks: 100, spend: 500, conversions: 10, revenue: 2000 },
      ]),
    });
    const res = await svc.adsPerformance('u1', { timeRange: { days: 30 } });
    expect(res.facts[0]).toMatchObject({ campaignId: 'c1', campaignName: '夏季主推', impressions: 1000, spend: 500 });
    expect(res.derived[0]).toMatchObject({ ctr: 0.1, cvr: 0.1, roas: 4, cpc: 5 });
    expect(adapter.adMetrics).toHaveBeenCalled();
  });

  it('analyticsSummary：四源聚合 + derived 比率（缺分母 → 0，不除零）', async () => {
    const now = new Date();
    const { svc, adapter } = makeService({
      revenue: vi.fn().mockResolvedValue([row(now, { revenue: 10000, netRevenue: 9500, refunds: 500, orders: 50 })]),
      traffic: vi.fn().mockResolvedValue([row(now, { impressions: 100000, visits: 5000, uniqueVisitors: 2000 })]),
      conversions: vi.fn().mockResolvedValue([row(now, { clicks: 3000, addToCart: 300, checkouts: 80, orders: 50, revenue: 10000 })]),
      adMetrics: vi.fn().mockResolvedValue([row(now, { campaignId: null, adId: null, impressions: 80000, clicks: 2000, spend: 3000, conversions: 40, revenue: 8000 })]),
    });
    const res = await svc.analyticsSummary('u1', { timeRange: { days: 30 } });
    expect(res.facts).toMatchObject({ revenue: 10000, orders: 50, impressions: 100000, visits: 5000, clicks: 5000, adSpend: 3000 });
    expect(res.derived).toMatchObject({ conversionRate: 0.01, roas: 2.67, aov: 200 });
    expect(adapter.revenue).toHaveBeenCalled();
  });

  it('analyticsCompare：两期变化率（changePct），零基数 → null（不伪造百分比）', async () => {
    const { svc } = makeService();
    // 用真实 service 的 analyticsSummary 数据源：mock 两次不同 revenue
    const now = new Date();
    const { svc: svc2, adapter } = makeService({
      revenue: vi.fn()
        .mockResolvedValueOnce([row(now, { revenue: 1000, netRevenue: 1000, refunds: 0, orders: 10 })])
        .mockResolvedValueOnce([row(now, { revenue: 1200, netRevenue: 1200, refunds: 0, orders: 12 })]),
      traffic: vi.fn().mockResolvedValue([]),
      conversions: vi.fn().mockResolvedValue([]),
      adMetrics: vi.fn().mockResolvedValue([]),
    });
    const res = await svc2.analyticsCompare('u1', { base: { days: 30 }, compare: { days: 30 } });
    expect((res.facts as Record<string, { changePct: number }>).revenue.changePct).toBe(20);
    expect(adapter.revenue).toHaveBeenCalledTimes(2);
    void svc;
  });

  it('连接解析：无连接 → NOT_FOUND（提示先连接）；吊销 → CONNECTION_NOT_ACTIVE；未知 provider → PROVIDER_UNSUPPORTED', async () => {
    const { svc, prisma } = makeService();
    prisma.connection.findFirst.mockResolvedValue(null);
    await expect(svc.analyticsSummary('u1', {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    prisma.connection.findFirst.mockResolvedValue({ id: 'c1', status: 'revoked', provider: 'mock' });
    await expect(svc.analyticsSummary('u1', {})).rejects.toMatchObject({ code: 'CONNECTION_NOT_ACTIVE' });
    await expect(svc.analyticsSummary('u1', { provider: 'shopify' })).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
  });

  it('trafficSummary：facts 按来源分布 + derived 人均访问（总量=all 行；source 是子集绝不重复计数）', async () => {
    const now = new Date();
    const { svc, adapter } = makeService({
      traffic: vi.fn().mockResolvedValue([
        row(now, { dimension: 'all', dimensionValue: 'all', impressions: 100, visits: 40, uniqueVisitors: 20 }),
        row(now, { dimension: 'source', dimensionValue: 'direct', impressions: 60, visits: 25, uniqueVisitors: 12 }),
        row(now, { dimension: 'source', dimensionValue: 'ads', impressions: 40, visits: 15, uniqueVisitors: 8 }),
      ]),
    });
    const res = await svc.trafficSummary('u1', {});
    expect(res.facts).toMatchObject({ impressions: 100, visits: 40, uniqueVisitors: 20 });
    expect(res.facts.bySource).toMatchObject({ direct: { impressions: 60 }, ads: { impressions: 40 } });
    expect(res.derived).toMatchObject({ avgVisitsPerVisitor: 2 });
    expect(adapter.traffic).toHaveBeenCalled();
  });
});
