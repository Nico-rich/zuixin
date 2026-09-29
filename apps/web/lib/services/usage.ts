import { apiFetch } from '@/lib/api';
import type { RunUsageAggregate } from '@/lib/services/agent-runs';

/**
 * Usage service（M13-F1）
 * 后端：apps/api/src/modules/usage/usage.controller.ts（JwtAuthGuard）——**只有一个端点**：
 * `GET /api/v1/usage/agent-runs/:id`（按 run 聚合的用量/成本）。
 *
 * 事实源说明（红线：UsageRecord 是唯一计费事实源）：
 *  - run 级用量 = UsageRecord 的聚合视图；页面的「用量」页面若要看组织级口径，
 *    应使用 `GET /api/v1/billing/usage`（账本口径，见 lib/services/billing.ts），
 *    或用 `GET /api/v1/analytics/overview` 的 facts.usage（含分层元信息）。
 *  - 前端**不做**任何金额/倍率计算。
 */
export type { RunUsageAggregate };

export const usageKeys = {
  run: (runId: string) => ['usage-run', runId] as const,
};

/** GET /api/v1/usage/agent-runs/:id */
export const getRunUsage = (runId: string) =>
  apiFetch<{ data: RunUsageAggregate }>(`/api/v1/usage/agent-runs/${runId}`);
