import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { CommerceProvider, CommerceTimeRange, ListParams } from './commerce-provider.interface';
import { MockCommerceAdapter } from './mock-commerce.adapter';

const MAX_RANGE_DAYS = 92;
const DEFAULT_DAYS = 30;
const MAX_PAGE_SIZE = 50;
const MAX_LIMIT = 100;

export interface TimeRangeInput {
  start?: string;
  end?: string;
  days?: number;
}

export interface CommerceToolInput {
  provider?: string;
  connectionId?: string;
  timeRange?: TimeRangeInput;
  page?: number;
  pageSize?: number;
  limit?: number;
  sort?: { field: string; dir: 'asc' | 'desc' };
  filters?: Record<string, string>;
  groupBy?: string;
  productId?: string;
  base?: TimeRangeInput;
  compare?: TimeRangeInput;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * M7-P4 Commerce 查询层（Tool → Service → Provider Adapter → 规范化数据）：
 * - 全部只读（P4 工具集无一写路径）；连接解析与 P3 同构（显式或默认 active 连接）；
 * - 数据真实性：结果严格分层 facts（原始聚合事实）/ derived（服务端计算的派生指标），
 *   LLM 解读/建议绝不出现在本层（P5 的 Analysis 层承接）；
 * - 时间窗校验：start<end、跨度 ≤92 天（防全表扫描），days 相对窗缺省 30 天。
 */
@Injectable()
export class CommerceService {
  private readonly providers = new Map<string, CommerceProvider>();

  constructor(@Inject(MockCommerceAdapter) mock: MockCommerceAdapter, @Inject(PrismaService) private readonly prisma: PrismaService) {
    this.providers.set(mock.name, mock);
  }

  private provider(name?: string): CommerceProvider {
    const p = this.providers.get(name ?? 'mock');
    if (!p) throw new AppError(ErrorCode.PROVIDER_UNSUPPORTED, '不支持的电商数据 Provider');
    return p;
  }

  resolveTimeRange(input?: TimeRangeInput): CommerceTimeRange {
    if (input?.start || input?.end) {
      const start = input.start ? new Date(input.start) : new Date(Date.now() - DEFAULT_DAYS * 86400_000);
      const end = input.end ? new Date(input.end) : new Date();
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, '时间范围非法（start 必须早于 end）');
      }
      const span = Math.ceil((end.getTime() - start.getTime()) / 86400_000);
      if (span > MAX_RANGE_DAYS) throw new AppError(ErrorCode.VALIDATION_ERROR, `时间跨度不得超过 ${MAX_RANGE_DAYS} 天`);
      return { start, end };
    }
    const days = Math.min(Math.max(1, input?.days ?? DEFAULT_DAYS), MAX_RANGE_DAYS);
    const end = new Date();
    return { start: new Date(end.getTime() - days * 86400_000), end };
  }

  private async resolveConnection(userId: string, provider: string, connectionId?: string) {
    const connection = connectionId
      ? await this.prisma.connection.findFirst({ where: { id: connectionId, userId, provider } })
      : await this.prisma.connection.findFirst({ where: { userId, provider, status: 'active' }, orderBy: { createdAt: 'asc' } });
    if (!connection) throw new AppError(ErrorCode.NOT_FOUND, '未找到可用的店铺连接，请先在「连接」中完成授权');
    if (connection.status !== 'active') throw new AppError(ErrorCode.CONNECTION_NOT_ACTIVE, '店铺连接不可用（已吊销/过期）');
    return connection;
  }

  private listParams(input: CommerceToolInput, timeRange: CommerceTimeRange): ListParams {
    return {
      page: Math.max(1, input.page ?? 1),
      pageSize: Math.min(Math.max(1, input.pageSize ?? 20), MAX_PAGE_SIZE),
      limit: Math.min(Math.max(1, input.limit ?? 50), MAX_LIMIT),
      sort: input.sort, filters: input.filters, groupBy: input.groupBy, timeRange,
    };
  }

  /** 商品列表（facts：分页商品事实；read-only） */
  async productsList(userId: string, input: CommerceToolInput) {
    const provider = this.provider(input.provider);
    const connection = await this.resolveConnection(userId, provider.name, input.connectionId);
    const params = this.listParams(input, this.resolveTimeRange(input.timeRange));
    const page = await provider.listProducts({ userId, connectionId: connection.id }, params);
    return { facts: { items: page.items, total: page.total, page: page.page, pageSize: page.pageSize }, meta: { provider: provider.name, readOnly: true, untrusted: true } };
  }

  async productsGet(userId: string, input: CommerceToolInput) {
    if (!input.productId) throw new AppError(ErrorCode.VALIDATION_ERROR, '缺少 productId');
    const provider = this.provider(input.provider);
    const connection = await this.resolveConnection(userId, provider.name, input.connectionId);
    const product = await provider.getProduct({ userId, connectionId: connection.id }, input.productId);
    if (!product) throw new AppError(ErrorCode.NOT_FOUND, '商品不存在');
    return { facts: { product }, meta: { provider: provider.name, readOnly: true, untrusted: true } };
  }

  async ordersList(userId: string, input: CommerceToolInput) {
    const provider = this.provider(input.provider);
    const connection = await this.resolveConnection(userId, provider.name, input.connectionId);
    const timeRange = this.resolveTimeRange(input.timeRange);
    const page = await provider.listOrders({ userId, connectionId: connection.id }, this.listParams(input, timeRange));
    return { facts: { items: page.items, total: page.total, page: page.page, pageSize: page.pageSize }, meta: { provider: provider.name, timeRange, readOnly: true, untrusted: true } };
  }

  /** 订单汇总：facts 原始聚合 + derived（客单价 aov） */
  async ordersSummary(userId: string, input: CommerceToolInput) {
    const provider = this.provider(input.provider);
    const connection = await this.resolveConnection(userId, provider.name, input.connectionId);
    const timeRange = this.resolveTimeRange(input.timeRange);
    const page = await provider.listOrders({ userId, connectionId: connection.id }, this.listParams(input, timeRange));
    const statusCount: Record<string, number> = {};
    let revenue = 0;
    let count = 0;
    for (const o of page.items) {
      statusCount[o.status] = (statusCount[o.status] ?? 0) + 1;
      if (o.status !== 'cancelled' && o.status !== 'refunded') { revenue += o.totalAmount; count++; }
    }
    return {
      facts: { orderCount: page.total, validOrderCount: count, revenue: round2(revenue), byStatus: statusCount },
      derived: { aov: count > 0 ? round2(revenue / count) : 0 },
      meta: { provider: provider.name, timeRange, readOnly: true, untrusted: true },
    };
  }

  /** 流量汇总：facts 总量 + bySource；derived 人均访问 */
  async trafficSummary(userId: string, input: CommerceToolInput) {
    const provider = this.provider(input.provider);
    const connection = await this.resolveConnection(userId, provider.name, input.connectionId);
    const timeRange = this.resolveTimeRange(input.timeRange);
    const rows = await provider.traffic({ userId, connectionId: connection.id }, timeRange);
    let impressions = 0, visits = 0, uniqueVisitors = 0;
    const bySource: Record<string, { impressions: number; visits: number }> = {};
    for (const r of rows) {
      // 总量只取 dimension=all 行（source 行是 all 行的子集，绝不同时累加——避免重复计数）
      if (r.dimension === 'all' || r.dimension === undefined) {
        impressions += r.impressions as number; visits += r.visits as number; uniqueVisitors += r.uniqueVisitors as number;
      }
      if (r.dimension === 'source' && typeof r.dimensionValue === 'string') {
        bySource[r.dimensionValue] = { impressions: r.impressions as number, visits: r.visits as number };
      }
    }
    return {
      facts: { impressions, visits, uniqueVisitors, bySource },
      derived: { avgVisitsPerVisitor: uniqueVisitors > 0 ? round2(visits / uniqueVisitors) : 0 },
      meta: { provider: provider.name, timeRange, readOnly: true, untrusted: true },
    };
  }

  async campaignsList(userId: string, input: CommerceToolInput) {
    const provider = this.provider(input.provider);
    const connection = await this.resolveConnection(userId, provider.name, input.connectionId);
    const page = await provider.listCampaigns({ userId, connectionId: connection.id }, this.listParams(input, this.resolveTimeRange(input.timeRange)));
    return { facts: { items: page.items, total: page.total, page: page.page, pageSize: page.pageSize }, meta: { provider: provider.name, readOnly: true, untrusted: true } };
  }

  /** 广告表现：按 campaign 分组——facts 原始聚合 + derived（ctr/cvr/roas/cpc，服务端计算，绝不混入 LLM 推测） */
  async adsPerformance(userId: string, input: CommerceToolInput) {
    const provider = this.provider(input.provider);
    const connection = await this.resolveConnection(userId, provider.name, input.connectionId);
    const timeRange = this.resolveTimeRange(input.timeRange);
    const rows = await provider.adMetrics({ userId, connectionId: connection.id }, timeRange);
    const campaigns = await provider.listCampaigns({ userId, connectionId: connection.id }, this.listParams(input, timeRange));
    const nameOf = new Map(campaigns.items.map((c) => [c.id, c.name]));
    const groups = new Map<string, { impressions: number; clicks: number; spend: number; conversions: number; revenue: number }>();
    const acc = (key: string | null) => {
      const k = key ?? 'unknown';
      if (!groups.has(k)) groups.set(k, { impressions: 0, clicks: 0, spend: 0, conversions: 0, revenue: 0 });
      return groups.get(k)!;
    };
    for (const r of rows) {
      const g = acc(r.campaignId);
      g.impressions += r.impressions as number; g.clicks += r.clicks as number; g.spend += r.spend as number;
      g.conversions += r.conversions as number; g.revenue += r.revenue as number;
    }
    const facts: Record<string, unknown>[] = [];
    const derived: Record<string, unknown>[] = [];
    for (const [campaignId, g] of groups) {
      facts.push({ campaignId, campaignName: nameOf.get(campaignId) ?? null, impressions: g.impressions, clicks: g.clicks, spend: round2(g.spend), conversions: g.conversions, revenue: round2(g.revenue) });
      derived.push({
        campaignId, campaignName: nameOf.get(campaignId) ?? null,
        ctr: g.impressions > 0 ? round2(g.clicks / g.impressions) : 0,
        cvr: g.clicks > 0 ? round2(g.conversions / g.clicks) : 0,
        roas: g.spend > 0 ? round2(g.revenue / g.spend) : 0,
        cpc: g.clicks > 0 ? round2(g.spend / g.clicks) : 0,
      });
    }
    return { facts, derived, meta: { provider: provider.name, timeRange, readOnly: true, untrusted: true } };
  }

  /** 分析汇总：跨 revenue/traffic/conversion/ad 四源聚合——facts 原始 + derived 比率 */
  async analyticsSummary(userId: string, input: CommerceToolInput) {
    const provider = this.provider(input.provider);
    const connection = await this.resolveConnection(userId, provider.name, input.connectionId);
    const timeRange = this.resolveTimeRange(input.timeRange);
    const [revenues, traffics, conversions, ads] = await Promise.all([
      provider.revenue({ userId, connectionId: connection.id }, timeRange),
      provider.traffic({ userId, connectionId: connection.id }, timeRange),
      provider.conversions({ userId, connectionId: connection.id }, timeRange),
      provider.adMetrics({ userId, connectionId: connection.id }, timeRange),
    ]);
    const sum = (rows: MetricRowLike[], key: string) => rows.reduce((s, r) => s + ((r[key] as number) ?? 0), 0);
    const revenue = sum(revenues, 'revenue');
    const netRevenue = sum(revenues, 'netRevenue');
    const refunds = sum(revenues, 'refunds');
    const orders = sum(revenues, 'orders');
    // 流量总量只取 dimension=all 行（source 行是子集，绝不重复计数）
    const totalTraffic = traffics.filter((r) => r.dimension === 'all' || r.dimension === undefined);
    const impressions = sum(totalTraffic, 'impressions');
    const visits = sum(totalTraffic, 'visits');
    const clicks = sum(conversions, 'clicks') + sum(ads, 'clicks');
    const spend = sum(ads, 'spend');
    const adConversions = sum(ads, 'conversions');
    const adRevenue = sum(ads, 'revenue');
    return {
      facts: {
        revenue: round2(revenue), netRevenue: round2(netRevenue), refunds: round2(refunds), orders,
        impressions, visits, clicks: Math.round(clicks), adSpend: round2(spend), adConversions, adRevenue: round2(adRevenue),
      },
      derived: {
        conversionRate: visits > 0 ? round2(orders / visits) : 0,
        ctr: impressions > 0 ? round2(clicks / impressions) : 0,
        roas: spend > 0 ? round2(adRevenue / spend) : 0,
        aov: orders > 0 ? round2(revenue / orders) : 0,
      },
      meta: { provider: provider.name, timeRange, readOnly: true, untrusted: true },
    };
  }

  /** 两期对比：facts 各指标两期值 + derived（变化率，服务端计算） */
  async analyticsCompare(userId: string, input: CommerceToolInput) {
    const base = await this.analyticsSummary(userId, { ...input, timeRange: input.base });
    const compare = await this.analyticsSummary(userId, { ...input, timeRange: input.compare });
    const factsA = base.facts as Record<string, number>;
    const factsB = compare.facts as Record<string, number>;
    const deltas: Record<string, { base: number; compare: number; changePct: number | null }> = {};
    for (const key of Object.keys(factsA)) {
      const a = factsA[key];
      const b = factsB[key] ?? 0;
      deltas[key] = { base: a, compare: b, changePct: a !== 0 ? round2(((b - a) / a) * 100) : null };
    }
    return { facts: deltas, derived: { note: 'changePct 为服务端计算的百分比变化；因果解读属于 LLM 推测，不得作为事实' }, meta: { provider: base.meta.provider, base: base.meta.timeRange, compare: compare.meta.timeRange, readOnly: true, untrusted: true } };
  }

  /** 库存汇总：facts 原始聚合 + derived 售罄率（read-only） */
  async inventorySummary(userId: string, input: CommerceToolInput) {
    const provider = this.provider(input.provider);
    const connection = await this.resolveConnection(userId, provider.name, input.connectionId);
    const timeRange = this.resolveTimeRange(input.timeRange);
    const rows = await provider.inventory({ userId, connectionId: connection.id }, timeRange);
    let stock = 0, reserved = 0, sold = 0;
    for (const r of rows) {
      stock += r.stock as number; reserved += r.reserved as number; sold += r.sold as number;
    }
    return {
      facts: { stock, reserved, sold },
      derived: { sellThrough: stock + sold > 0 ? round2(sold / (stock + sold)) : 0 },
      meta: { provider: provider.name, timeRange, readOnly: true, untrusted: true },
    };
  }
}

type MetricRowLike = Record<string, unknown>;
