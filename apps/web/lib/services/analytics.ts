import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Analytics service（M13-F1）
 * 后端：apps/api/src/modules/analytics/analytics.controller.ts（JwtAuthGuard + 组织成员校验）
 *
 * 口径：响应固定分层 `facts`（事实）/ `derived`（派生）/ `meta`（来源与新鲜度）。
 * 页面必须把 `meta.layering` 与 `meta.refreshedAt` 如实呈现——**派生值不是事实源**。
 */
export type AnalyticsRange = 'day' | 'week' | 'month';
export type AnalyticsKind = 'usage' | 'agent' | 'generation' | 'provider' | 'workflow';

export interface AnalyticsOverview {
  organizationId: string;
  range: AnalyticsRange;
  from: string;
  to: string;
  days: number;
  facts: Record<string, unknown>;
  context: { members: number };
  derived: {
    totalCost: number; llmCost: number; providerCost: number;
    runSuccessRate: number; avgRunDurationMs: number; costPerRun: number;
    costPerMember: number; costPerDay: number; runsPerDay: number;
    imagesPerDay: number; workflowSuccessRate: number;
  };
  meta: { source: string[]; refreshedAt: string | null; rows: number; layering: unknown };
}

export interface AnalyticsBreakdown {
  organizationId: string;
  kind: AnalyticsKind;
  from: string;
  to: string;
  days: number;
  series: Array<{ kind: string; period: string; metrics: unknown; dimensions: unknown; source: string }>;
  facts: unknown;
  meta: unknown;
}

export interface AnalyticsSources {
  organizationId: string;
  period: string;
  kindSourceMap: unknown;
  count: number;
  sources: Array<{ kind: string; source: string; period: string; scope: string; metricKeys: unknown; dimensions: unknown; refreshedAt: string }>;
  layering: unknown;
}

export const analyticsKeys = {
  overview: (organizationId?: string, range?: AnalyticsRange) => ['analytics-overview', organizationId ?? null, range ?? 'day'] as const,
  breakdown: (params: { organizationId?: string; kind?: AnalyticsKind; days?: number }) => ['analytics-breakdown', params] as const,
  sources: (organizationId?: string, period?: string) => ['analytics-sources', organizationId ?? null, period ?? null] as const,
};

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
  const query = s.toString();
  return query ? `?${query}` : '';
};

/** GET /api/v1/analytics/overview */
export const getAnalyticsOverview = (params: { organizationId?: string; range?: AnalyticsRange } = {}) =>
  apiFetch<{ data: AnalyticsOverview }>(`/api/v1/analytics/overview${qs(params)}`);

/** GET /api/v1/analytics/breakdown（kind 省略则由后端默认） */
export const getAnalyticsBreakdown = (params: { organizationId?: string; kind?: AnalyticsKind; days?: number } = {}) =>
  apiFetch<{ data: AnalyticsBreakdown }>(`/api/v1/analytics/breakdown${qs(params)}`);

/** POST /api/v1/analytics/refresh（需 owner / billing.write） */
export const refreshAnalytics = (input: { organizationId?: string; from?: string; to?: string } = {}) =>
  apiFetch<{ data: { organizationId: string; from: string; to: string; days: number; periods: string[] } }>(
    '/api/v1/analytics/refresh', jsonInit('POST', input),
  );

/** GET /api/v1/analytics/sources（来源与新鲜度） */
export const getAnalyticsSources = (params: { organizationId?: string; period?: string } = {}) =>
  apiFetch<{ data: AnalyticsSources }>(`/api/v1/analytics/sources${qs(params)}`);
