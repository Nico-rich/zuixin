/**
 * M7-P4 Commerce Provider 统一抽象（只读）：
 * Agent 绝不直连 Shopify/Amazon/Meta/Google/TikTok 数据——管线固定：
 * External API → Provider Adapter → Normalize → CommerceService → Commerce Tool → Agent。
 * 当前唯一实现 = MockCommerceAdapter（读规范化种子数据，明确标注 mock，绝不伪造真实第三方数据）；
 * 真实平台适配器实现本接口（含分页/过滤/时区归一），无真实凭据前不注册。
 */

export interface CommerceTimeRange {
  start: Date;
  end: Date;
}

export interface ListParams {
  page: number;
  pageSize: number;
  sort?: { field: string; dir: 'asc' | 'desc' };
  filters?: Record<string, string>;
  groupBy?: string;
  timeRange: CommerceTimeRange;
  limit: number;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CommerceProductView {
  id: string;
  externalId: string;
  title: string;
  price: number | null;
  currency: string;
  status: string;
  sku: string | null;
  inventory: number | null;
  category: string | null;
}

export interface CommerceOrderView {
  id: string;
  externalId: string;
  orderNumber: string;
  status: string;
  totalAmount: number;
  currency: string;
  itemCount: number;
  orderedAt: string;
}

export interface CommerceCampaignView {
  id: string;
  externalId: string;
  name: string;
  status: string;
  objective: string | null;
  budget: number | null;
  adGroupCount: number;
}

export interface MetricRow {
  periodStart: Date;
  periodEnd: Date;
  dimensionValue?: string;
  [key: string]: unknown;
}

export interface CommerceProvider {
  name: string;
  listProducts(ctx: { userId: string; connectionId: string }, params: ListParams): Promise<PagedResult<CommerceProductView>>;
  getProduct(ctx: { userId: string; connectionId: string }, productId: string): Promise<CommerceProductView | null>;
  listOrders(ctx: { userId: string; connectionId: string }, params: ListParams): Promise<PagedResult<CommerceOrderView>>;
  traffic(ctx: { userId: string; connectionId: string }, timeRange: CommerceTimeRange): Promise<MetricRow[]>;
  conversions(ctx: { userId: string; connectionId: string }, timeRange: CommerceTimeRange): Promise<MetricRow[]>;
  listCampaigns(ctx: { userId: string; connectionId: string }, params: ListParams): Promise<PagedResult<CommerceCampaignView>>;
  adMetrics(ctx: { userId: string; connectionId: string }, timeRange: CommerceTimeRange): Promise<Array<MetricRow & { campaignId: string | null; adId: string | null }>>;
  revenue(ctx: { userId: string; connectionId: string }, timeRange: CommerceTimeRange): Promise<MetricRow[]>;
  inventory(ctx: { userId: string; connectionId: string }, timeRange: CommerceTimeRange): Promise<MetricRow[]>;
}
