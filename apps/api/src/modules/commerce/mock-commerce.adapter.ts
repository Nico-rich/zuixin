import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CommerceProvider, CommerceTimeRange, ListParams, PagedResult,
  CommerceProductView, CommerceOrderView, CommerceCampaignView, MetricRow,
} from './commerce-provider.interface';

const SORTABLE: Record<string, string> = {
  price: 'price', title: 'title', createdAt: 'createdAt',
  orderedAt: 'orderedAt', totalAmount: 'totalAmount', name: 'name',
};

/**
 * M7-P4 Mock Commerce Adapter：直接读规范化种子数据层（userId+provider 隔离），
 * 不伪造外部 API——数据由测试/种子明确写入并标注 mock。
 * 真实平台适配器将以同一接口替换本实现（External API → 归一化 → 本层）。
 */
@Injectable()
export class MockCommerceAdapter implements CommerceProvider {
  readonly name = 'mock';

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private orderBy(params: ListParams, fallback: string) {
    if (!params.sort || !SORTABLE[params.sort.field]) return [{ [fallback]: 'desc' as const }];
    return [{ [SORTABLE[params.sort.field]]: params.sort.dir }];
  }

  async listProducts(ctx: { userId: string; connectionId: string }, params: ListParams): Promise<PagedResult<CommerceProductView>> {
    const where = {
      userId: ctx.userId, provider: this.name,
      ...(params.filters?.status ? { status: params.filters.status } : {}),
      ...(params.filters?.category ? { category: params.filters.category } : {}),
      ...(params.filters?.q ? { title: { contains: params.filters.q } } : {}),
      ...(params.filters?.minPrice ? { price: { gte: Number(params.filters.minPrice) } } : {}),
      ...(params.filters?.maxPrice ? { price: { lte: Number(params.filters.maxPrice) } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.commerceProduct.count({ where }),
      this.prisma.commerceProduct.findMany({
        where, skip: (params.page - 1) * params.pageSize, take: params.pageSize,
        orderBy: this.orderBy(params, 'createdAt'),
      }),
    ]);
    return {
      total, page: params.page, pageSize: params.pageSize,
      items: rows.map((r) => ({
        id: r.id, externalId: r.externalId, title: r.title, price: r.price, currency: r.currency,
        status: r.status, sku: r.sku, inventory: r.inventory, category: r.category,
      })),
    };
  }

  async getProduct(ctx: { userId: string; connectionId: string }, productId: string): Promise<CommerceProductView | null> {
    const r = await this.prisma.commerceProduct.findFirst({
      where: { userId: ctx.userId, provider: this.name, OR: [{ id: productId }, { externalId: productId }] },
    });
    return r ? {
      id: r.id, externalId: r.externalId, title: r.title, price: r.price, currency: r.currency,
      status: r.status, sku: r.sku, inventory: r.inventory, category: r.category,
    } : null;
  }

  async listOrders(ctx: { userId: string; connectionId: string }, params: ListParams): Promise<PagedResult<CommerceOrderView>> {
    const where = {
      userId: ctx.userId, provider: this.name,
      orderedAt: { gte: params.timeRange.start, lte: params.timeRange.end },
      ...(params.filters?.status ? { status: params.filters.status } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.commerceOrder.count({ where }),
      this.prisma.commerceOrder.findMany({
        where, skip: (params.page - 1) * params.pageSize, take: params.pageSize,
        orderBy: this.orderBy(params, 'orderedAt'),
      }),
    ]);
    return {
      total, page: params.page, pageSize: params.pageSize,
      items: rows.map((r) => ({
        id: r.id, externalId: r.externalId, orderNumber: r.orderNumber, status: r.status,
        totalAmount: r.totalAmount, currency: r.currency, itemCount: r.itemCount, orderedAt: r.orderedAt.toISOString(),
      })),
    };
  }

  async traffic(ctx: { userId: string; connectionId: string }, timeRange: CommerceTimeRange): Promise<MetricRow[]> {
    const rows = await this.prisma.commerceTrafficMetric.findMany({
      where: { userId: ctx.userId, provider: this.name, periodStart: { gte: timeRange.start }, periodEnd: { lte: timeRange.end } },
    });
    return rows.map((r) => ({
      periodStart: r.periodStart, periodEnd: r.periodEnd,
      dimension: r.dimension, dimensionValue: r.dimensionValue,
      impressions: r.impressions, visits: r.visits, uniqueVisitors: r.uniqueVisitors,
    }));
  }

  async conversions(ctx: { userId: string; connectionId: string }, timeRange: CommerceTimeRange): Promise<MetricRow[]> {
    const rows = await this.prisma.commerceConversionMetric.findMany({
      where: { userId: ctx.userId, provider: this.name, periodStart: { gte: timeRange.start }, periodEnd: { lte: timeRange.end } },
    });
    return rows.map((r) => ({
      periodStart: r.periodStart, periodEnd: r.periodEnd,
      dimension: r.dimension, dimensionValue: r.dimensionValue,
      clicks: r.clicks, addToCart: r.addToCart, checkouts: r.checkouts, orders: r.orders, revenue: r.revenue,
    }));
  }

  async listCampaigns(ctx: { userId: string; connectionId: string }, params: ListParams): Promise<PagedResult<CommerceCampaignView>> {
    const where = {
      userId: ctx.userId, provider: this.name,
      ...(params.filters?.status ? { status: params.filters.status } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.commerceCampaign.count({ where }),
      this.prisma.commerceCampaign.findMany({
        where, skip: (params.page - 1) * params.pageSize, take: params.pageSize,
        orderBy: this.orderBy(params, 'createdAt'),
        include: { _count: { select: { adGroups: true } } },
      }),
    ]);
    return {
      total, page: params.page, pageSize: params.pageSize,
      items: rows.map((r) => ({
        id: r.id, externalId: r.externalId, name: r.name, status: r.status,
        objective: r.objective, budget: r.budget, adGroupCount: r._count.adGroups,
      })),
    };
  }

  async adMetrics(ctx: { userId: string; connectionId: string }, timeRange: CommerceTimeRange) {
    const rows = await this.prisma.commerceAdMetric.findMany({
      where: { userId: ctx.userId, provider: this.name, periodStart: { gte: timeRange.start }, periodEnd: { lte: timeRange.end } },
    });
    return rows.map((r) => ({
      periodStart: r.periodStart, periodEnd: r.periodEnd,
      campaignId: r.campaignId, adId: r.adId,
      impressions: r.impressions, clicks: r.clicks, spend: r.spend, conversions: r.conversions, revenue: r.revenue,
    }));
  }

  async revenue(ctx: { userId: string; connectionId: string }, timeRange: CommerceTimeRange): Promise<MetricRow[]> {
    const rows = await this.prisma.commerceRevenueMetric.findMany({
      where: { userId: ctx.userId, provider: this.name, periodStart: { gte: timeRange.start }, periodEnd: { lte: timeRange.end } },
    });
    return rows.map((r) => ({
      periodStart: r.periodStart, periodEnd: r.periodEnd, dimensionValue: 'all',
      revenue: r.revenue, orders: r.orders, refunds: r.refunds, netRevenue: r.netRevenue,
    }));
  }

  async inventory(ctx: { userId: string; connectionId: string }, timeRange: CommerceTimeRange): Promise<MetricRow[]> {
    const rows = await this.prisma.commerceInventoryMetric.findMany({
      where: { userId: ctx.userId, provider: this.name, periodStart: { gte: timeRange.start }, periodEnd: { lte: timeRange.end } },
    });
    return rows.map((r) => ({
      periodStart: r.periodStart, periodEnd: r.periodEnd, dimensionValue: 'all', productId: r.productId,
      stock: r.stock, reserved: r.reserved, sold: r.sold,
    }));
  }
}
