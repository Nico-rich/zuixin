import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Billing service（M13-F1）
 * 后端：apps/api/src/modules/billing/billing.controller.ts（JwtAuthGuard + 组织 RBAC）
 *
 * `organizationId` 省略时后端按**调用者的个人组织**结算（服务端裁定，前端不猜）。
 * 金额/权益一律以服务端返回为准（前端不做金额计算）。
 */
export interface Plan {
  id: string;
  code: string;
  name: string;
  monthlyPrice: number;
  yearlyPrice: number;
  entitlements: Record<string, number>;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionView {
  organizationId: string;
  plan: string;
  status: string;
  entitlements: Record<string, number>;
  currentPeriodEnd: string | null;
}

export interface BillingUsageView {
  organizationId: string;
  period: string;
  facts: Record<string, number>;
  derived: { totalUsageKinds: number; llmCost: number };
  layering: unknown;
}

export interface Invoice {
  id: string;
  organizationId: string;
  subscriptionId: string | null;
  number: string;
  status: 'draft' | 'open' | 'paid' | 'void';
  amount: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscribeResult {
  subscriptionId: string;
  plan: string;
  status: 'active';
  invoice: { id: string; number: string; amount: number; status: 'paid' };
  entitlements: Record<string, number>;
}

export const billingKeys = {
  plans: ['billing-plans'] as const,
  subscription: (organizationId?: string) => ['billing-subscription', organizationId ?? null] as const,
  usage: (organizationId?: string, period?: string) => ['billing-usage', organizationId ?? null, period ?? null] as const,
  reconciliation: (organizationId?: string, period?: string) => ['billing-reconciliation', organizationId ?? null, period ?? null] as const,
  invoices: (organizationId?: string) => ['billing-invoices', organizationId ?? null] as const,
};

const orgQuery = (params: { organizationId?: string; period?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.organizationId) qs.set('organizationId', params.organizationId);
  if (params.period) qs.set('period', params.period);
  const query = qs.toString();
  return query ? `?${query}` : '';
};

/** GET /api/v1/billing/plans（active=true，monthlyPrice asc） */
export const listPlans = () => apiFetch<{ data: Plan[] }>('/api/v1/billing/plans');

/** GET /api/v1/billing/subscription */
export const getSubscription = (organizationId?: string) =>
  apiFetch<{ data: SubscriptionView }>(`/api/v1/billing/subscription${orgQuery({ organizationId })}`);

/** GET /api/v1/billing/usage（period 形如 YYYY-MM；账本口径，非估算） */
export const getBillingUsage = (params: { organizationId?: string; period?: string } = {}) =>
  apiFetch<{ data: BillingUsageView }>(`/api/v1/billing/usage${orgQuery(params)}`);

/** GET /api/v1/billing/reconciliation（用量记录 vs 账本对账诊断） */
export const getReconciliation = (params: { organizationId?: string; period?: string } = {}) =>
  apiFetch<{ data: unknown }>(`/api/v1/billing/reconciliation${orgQuery(params)}`);

/** GET /api/v1/billing/invoices（createdAt desc，take 50） */
export const listInvoices = (organizationId?: string) =>
  apiFetch<{ data: Invoice[] }>(`/api/v1/billing/invoices${orgQuery({ organizationId })}`);

/** POST /api/v1/billing/subscribe */
export const subscribe = (input: { organizationId: string; planId: string }) =>
  apiFetch<{ data: SubscribeResult }>('/api/v1/billing/subscribe', jsonInit('POST', input));
