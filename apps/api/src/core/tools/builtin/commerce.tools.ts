import { z } from 'zod';
import { Tool } from '../tool.types';
import { CommerceService, CommerceToolInput } from '../../../modules/commerce/commerce.service';

/**
 * M7-P4 Commerce 工具集（第一批 9 个，全部 read-only，绝不修改电商数据）：
 * 统一参数：timeRange{start,end,days} / filters / page/pageSize / sort / groupBy / limit。
 * 结果分层：facts（原始事实）/ derived（服务端计算的派生指标）——LLM 解读绝不混入。
 */
const TimeRangeSchema = z.strictObject({
  start: z.string().optional(),
  end: z.string().optional(),
  days: z.number().int().min(1).max(92).optional(),
}).optional();

const commonSchema = z.strictObject({
  provider: z.string().min(1).max(40).optional(),
  connectionId: z.string().uuid().optional(),
  timeRange: TimeRangeSchema,
});

const pageSchema = z.strictObject({
  page: z.number().int().min(1).max(1000).optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  sort: z.strictObject({ field: z.string().min(1).max(30), dir: z.enum(['asc', 'desc']) }).optional(),
  filters: z.record(z.string(), z.string()).optional(),
});

function commerceTool(name: string, description: string, extraSchema: Record<string, z.ZodType>, handler: (input: CommerceToolInput, userId: string) => Promise<unknown>): Tool {
  return {
    name, description, permission: 'read', // P4 全部 read-only：无审批、无写路径
    inputSchema: z.strictObject({ ...extraSchema }),
    execute: async (raw, ctx) => handler(raw as CommerceToolInput, ctx.userId),
  };
}

export function createCommerceTools(commerce: CommerceService): Tool[] {
  return [
    commerceTool('commerce.products.list', '列出店铺商品（支持分页/过滤/排序）。结果含 facts 原始数据。',
      { ...commonSchema.shape, ...pageSchema.shape },
      (input, userId) => commerce.productsList(userId, input)),
    commerceTool('commerce.products.get', '按 id/externalId 查询单个商品。',
      { ...commonSchema.shape, productId: z.string().min(1).max(100) },
      (input, userId) => commerce.productsGet(userId, input)),
    commerceTool('commerce.orders.list', '列出订单（支持状态过滤/分页/时间窗）。',
      { ...commonSchema.shape, ...pageSchema.shape },
      (input, userId) => commerce.ordersList(userId, input)),
    commerceTool('commerce.orders.summary', '订单汇总：订单数/营收/状态分布（facts）+ 客单价（derived）。',
      { ...commonSchema.shape },
      (input, userId) => commerce.ordersSummary(userId, input)),
    commerceTool('commerce.traffic.summary', '流量汇总：曝光/访问/访客（facts）+ 按来源分布 + 人均访问（derived）。',
      { ...commonSchema.shape },
      (input, userId) => commerce.trafficSummary(userId, input)),
    commerceTool('commerce.ads.campaigns.list', '列出广告系列（状态过滤/分页）。',
      { ...commonSchema.shape, ...pageSchema.shape },
      (input, userId) => commerce.campaignsList(userId, input)),
    commerceTool('commerce.ads.performance', '广告表现（按系列分组）：facts（曝光/点击/花费/转化/营收）+ derived（CTR/CVR/ROAS/CPC）。',
      { ...commonSchema.shape },
      (input, userId) => commerce.adsPerformance(userId, input)),
    commerceTool('commerce.analytics.summary', '店铺分析汇总：营收/订单/流量/广告花费（facts）+ 转化率/ROAS/客单价（derived）。',
      { ...commonSchema.shape },
      (input, userId) => commerce.analyticsSummary(userId, input)),
    commerceTool('commerce.analytics.compare', '两期对比：base 与 compare 各指标变化率（derived）；因果解读需由你（LLM）基于事实另行判断。',
      {
        ...commonSchema.shape,
        base: TimeRangeSchema,
        compare: TimeRangeSchema,
      },
      (input, userId) => commerce.analyticsCompare(userId, input)),
  ];
}
