'use client';

import { useState } from 'react';
import { ApiErrorNotice, NoPermissionBadge } from '@/components/api-error-notice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useApiMutation, useApiQuery, useApiQueryClient, type ApiError } from '@/lib/api';
import {
  billingKeys, subscribe,
  type BillingUsageView, type Invoice, type Plan, type SubscriptionView,
} from '@/lib/services/billing';
import { organizationKeys, type OrganizationSummary } from '@/lib/services/organizations';
import { ReconciliationPanel } from './reconciliation-panel';

/**
 * 账单（M13-W5）：订阅 / 计划 / 用量 / 发票 / 对账。
 *
 * 事实源纪律：金额、权益、用量一律以服务端返回为准——前端**不做**金额计算、不换算单位、
 * 不从本地推算权益。`organizationId` 显式传给每个组织级端点（省略时后端按个人组织结算，
 * 但选择权交给用户后就不用「隐式默认」这条路径）。
 *
 * RBAC（服务端裁决，前端只按返回的 role 显隐）：读 = owner/admin/member（viewer 403），
 * 订阅（billing.write）= **仅 owner**。因此非 owner 位置上不渲染订阅按钮，而是显示「无权限」
 * 徽标；若服务端仍然返回 403，错误照原样呈现（前端判定永不算数）。
 */

const READER_ROLES = ['owner', 'admin', 'member'];

/** 账期（UTC，与后端 periodOf 同口径：绝不本地时区漂移） */
const currentPeriod = (now = new Date()): string =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

/** 与 lib/services/billing.ts 的 orgQuery 同形（页面必须与 service 路径保持一致，单测钉住字面量） */
const orgQuery = (params: { organizationId?: string; period?: string } = {}): string => {
  const qs = new URLSearchParams();
  if (params.organizationId) qs.set('organizationId', params.organizationId);
  if (params.period) qs.set('period', params.period);
  const query = qs.toString();
  return query ? `?${query}` : '';
};

/** layering 在 service 里是 unknown（后端未进 shared）→ 防御式收窄，结构不认识就不渲染 */
const layeringOf = (raw: unknown): { facts: string; derived: string } | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return typeof r.facts === 'string' && typeof r.derived === 'string' ? { facts: r.facts, derived: r.derived } : null;
};

const fmtMoney = (amount: number, currency = 'CNY'): string =>
  currency === 'CNY' ? `¥${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`;
const fmtTime = (value: string | null): string => (value ? new Date(value).toLocaleString() : '—');
const errText = (e: ApiError): string => `${e.message}（${e.code}）`;

const INVOICE_VARIANT: Record<Invoice['status'], 'secondary' | 'warning' | 'success' | 'outline'> = {
  draft: 'secondary', open: 'warning', paid: 'success', void: 'outline',
};

function EntitlementGrid({ entitlements }: { entitlements: Record<string, number> }) {
  const entries = Object.entries(entitlements);
  if (entries.length === 0) return <p className="text-xs text-zinc-500">无权益明细</p>;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-baseline justify-between gap-2 text-xs">
          <dt className="truncate text-zinc-500" title={key}>{key}</dt>
          <dd className="shrink-0 text-zinc-200">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function BillingPage() {
  const queryClient = useApiQueryClient();
  const { toast } = useToast();

  const [orgId, setOrgId] = useState<string | null>(null);
  const [period, setPeriod] = useState(currentPeriod());
  const [confirmPlan, setConfirmPlan] = useState<Plan | null>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  const orgs = useApiQuery<{ data: OrganizationSummary[] }>({
    queryKey: organizationKeys.all, path: '/api/v1/organizations',
  });
  const orgList = orgs.data?.data ?? [];
  const activeOrgId = orgId ?? orgList[0]?.id ?? null;
  const activeOrg = orgList.find((o) => o.id === activeOrgId) ?? null;
  const myRole = activeOrg?.members[0]?.role ?? null;
  const canRead = myRole !== null && READER_ROLES.includes(myRole);
  const canSubscribe = myRole === 'owner';
  const ready = activeOrgId !== null;

  const plans = useApiQuery<{ data: Plan[] }>({ queryKey: billingKeys.plans, path: '/api/v1/billing/plans' });

  const subscription = useApiQuery<{ data: SubscriptionView }>({
    queryKey: billingKeys.subscription(activeOrgId ?? undefined),
    path: `/api/v1/billing/subscription${orgQuery({ organizationId: activeOrgId ?? undefined })}`,
    enabled: ready,
  });
  const usage = useApiQuery<{ data: BillingUsageView }>({
    queryKey: billingKeys.usage(activeOrgId ?? undefined, period),
    path: `/api/v1/billing/usage${orgQuery({ organizationId: activeOrgId ?? undefined, period })}`,
    enabled: ready,
  });
  const invoices = useApiQuery<{ data: Invoice[] }>({
    queryKey: billingKeys.invoices(activeOrgId ?? undefined),
    path: `/api/v1/billing/invoices${orgQuery({ organizationId: activeOrgId ?? undefined })}`,
    enabled: ready,
  });
  // 对账返回 unknown（后端类型未进 shared）→ 由 ReconciliationPanel 防御式收窄
  const reconciliation = useApiQuery<{ data: unknown }>({
    queryKey: billingKeys.reconciliation(activeOrgId ?? undefined, period),
    path: `/api/v1/billing/reconciliation${orgQuery({ organizationId: activeOrgId ?? undefined, period })}`,
    enabled: ready,
  });

  const subscribeMutation = useApiMutation((planId: string) => subscribe({ organizationId: activeOrgId ?? '', planId }), {
    onSuccess: (res) => {
      setActionError('');
      setNotice(`订阅成功：${res.data.plan} · 发票 ${res.data.invoice.number} ${fmtMoney(res.data.invoice.amount)}`);
      toast({ title: '订阅成功', description: `计划 ${res.data.plan}`, variant: 'success' });
      setConfirmPlan(null);
      void queryClient.invalidateQueries({ queryKey: billingKeys.subscription(activeOrgId ?? undefined) });
      void queryClient.invalidateQueries({ queryKey: billingKeys.invoices(activeOrgId ?? undefined) });
    },
    onError: (e) => { setNotice(''); setActionError(`订阅失败：${errText(e)}`); setConfirmPlan(null); },
  });

  const usageFacts = Object.entries(usage.data?.data.facts ?? {});
  const layering = layeringOf(usage.data?.data.layering);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold text-zinc-100">账单</h1>
        <span className="text-xs text-zinc-500">金额与权益一律以服务端为准 · 用量为账本口径（非估算）</span>
      </div>

      {notice && <p className="mb-3 text-xs text-emerald-400" role="status">{notice}</p>}
      {actionError && <p className="mb-3 text-xs text-red-400" role="alert">{actionError}</p>}

      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-end gap-4 pt-3">
          <div className="min-w-56">
            <label className="mb-1 block text-xs text-zinc-500" htmlFor="billing-org">组织</label>
            <Select id="billing-org" aria-label="组织" value={activeOrgId ?? ''} onChange={(e) => setOrgId(e.target.value)}>
              {orgList.length === 0 && <option value="">（无组织）</option>}
              {orgList.map((o) => (
                <option key={o.id} value={o.id}>{o.name}{o.isPersonal ? '（个人）' : ''}</option>
              ))}
            </Select>
          </div>
          <div className="w-40">
            <label className="mb-1 block text-xs text-zinc-500" htmlFor="billing-period">账期（UTC）</label>
            <Input id="billing-period" aria-label="账期" value={period} placeholder="YYYY-MM"
              onChange={(e) => setPeriod(e.target.value.trim())} className="h-10" />
          </div>
          <div className="flex items-center gap-2 pb-2 text-xs text-zinc-500">
            <span>我的角色</span>
            {myRole ? <Badge variant="default">{myRole}</Badge> : <NoPermissionBadge label="非成员" />}
            {myRole && !canRead && <span className="text-zinc-600">账本读权限需 owner/admin/member</span>}
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>当前订阅</CardTitle>
          <CardDescription>订阅状态与权益额度摘要（entitlements 由服务端返回）</CardDescription>
        </CardHeader>
        <CardContent>
          {!ready && <Skeleton className="h-20 w-full" />}
          {ready && subscription.isPending && <Skeleton className="h-20 w-full" />}
          {ready && subscription.error && <ApiErrorNotice error={subscription.error} prefix="订阅加载失败：" />}
          {ready && subscription.data && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant="info">{subscription.data.data.plan}</Badge>
                <Badge variant={subscription.data.data.status === 'active' ? 'success' : 'warning'}>
                  {subscription.data.data.status}
                </Badge>
                <span className="text-xs text-zinc-500">
                  当前周期结束 {fmtTime(subscription.data.data.currentPeriodEnd)}
                </span>
              </div>
              <EntitlementGrid entitlements={subscription.data.data.entitlements} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>计划</CardTitle>
          <CardDescription>
            订阅（billing.write）仅组织 owner 可执行；确认后服务端生成订阅与发票（发票金额以服务端为准）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {plans.isPending && <Skeleton className="h-32 w-full" />}
          {plans.error && <ApiErrorNotice error={plans.error} prefix="计划加载失败：" />}
          {plans.data && (
            <div className="grid gap-4 sm:grid-cols-2">
              {plans.data.data.map((plan) => (
                <Card key={plan.id}>
                  <CardHeader>
                    <CardTitle>{plan.name}</CardTitle>
                    <CardDescription>{plan.code}{plan.active ? '' : ' · 已停用'}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-zinc-200">
                      {fmtMoney(plan.monthlyPrice)} / 月 · {fmtMoney(plan.yearlyPrice)} / 年
                    </p>
                    <EntitlementGrid entitlements={plan.entitlements} />
                  </CardContent>
                  <CardFooter>
                    {canSubscribe ? (
                      <Button size="sm" aria-label={`订阅 ${plan.name}`} onClick={() => setConfirmPlan(plan)}>
                        升级订阅
                      </Button>
                    ) : (
                      <span className="flex items-center gap-2">
                        <NoPermissionBadge />
                        <span className="text-xs text-zinc-600">仅组织 owner 可订阅</span>
                      </span>
                    )}
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>用量</CardTitle>
          <CardDescription>
            facts = 账本条目按类型聚合的原始事实（llm_cost 为金额、其余为计数，服务端不做跨类型换算）；
            derived = 服务端派生值（不落库）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!ready && <Skeleton className="h-24 w-full" />}
          {ready && usage.isPending && <Skeleton className="h-24 w-full" />}
          {ready && usage.error && <ApiErrorNotice error={usage.error} prefix="用量加载失败：" />}
          {ready && usage.data && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                <span>账期 {usage.data.data.period}</span>
                {layering && (
                  <>
                    <Badge variant="outline">facts：{layering.facts}</Badge>
                    <Badge variant="outline">derived：{layering.derived}</Badge>
                  </>
                )}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>类型（账本 kind）</TableHead>
                    <TableHead>数量/金额</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usageFacts.length === 0 && <TableEmpty colSpan={2}>该账期无用量记录</TableEmpty>}
                  {usageFacts.map(([kind, value]) => (
                    <TableRow key={kind}>
                      <TableCell className="text-zinc-300">{kind}</TableCell>
                      <TableCell>{kind === 'llm_cost' ? fmtMoney(value) : value}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex flex-wrap gap-6 text-xs text-zinc-400">
                <span>用量类型数 totalUsageKinds：{usage.data.data.derived.totalUsageKinds}</span>
                <span>LLM 成本 llmCost：{fmtMoney(usage.data.data.derived.llmCost)}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>发票</CardTitle>
          <CardDescription>最近 50 张（创建时间倒序）· 状态与金额由服务端记账流程写入</CardDescription>
        </CardHeader>
        <CardContent>
          {!ready && <Skeleton className="h-24 w-full" />}
          {ready && invoices.isPending && <Skeleton className="h-24 w-full" />}
          {ready && invoices.error && <ApiErrorNotice error={invoices.error} prefix="发票加载失败：" />}
          {ready && invoices.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>发票号</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>金额</TableHead>
                  <TableHead>账期</TableHead>
                  <TableHead>支付时间</TableHead>
                  <TableHead>创建时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.data.data.length === 0 && <TableEmpty colSpan={6}>暂无发票</TableEmpty>}
                {invoices.data.data.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-mono text-xs text-zinc-300">{inv.number}</TableCell>
                    <TableCell><Badge variant={INVOICE_VARIANT[inv.status]}>{inv.status}</Badge></TableCell>
                    <TableCell>{fmtMoney(inv.amount, inv.currency)}</TableCell>
                    <TableCell className="text-xs text-zinc-500">
                      {new Date(inv.periodStart).toLocaleDateString()} — {new Date(inv.periodEnd).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-zinc-400">{fmtTime(inv.paidAt)}</TableCell>
                    <TableCell className="text-zinc-500">{fmtTime(inv.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>对账（用量记录 ↔ 账本）</CardTitle>
          <CardDescription>
            只读诊断：缺失/重复/不符/孤儿/仅账本/未关联逐段列出，结论由服务端给出。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!ready && <Skeleton className="h-24 w-full" />}
          {ready && reconciliation.isPending && <Skeleton className="h-24 w-full" />}
          {ready && reconciliation.error && <ApiErrorNotice error={reconciliation.error} prefix="对账加载失败：" />}
          {ready && reconciliation.data && <ReconciliationPanel raw={reconciliation.data.data} />}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmPlan !== null}
        onOpenChange={(open) => { if (!open) setConfirmPlan(null); }}
        title="确认订阅"
        description={confirmPlan
          ? `将组织 ${activeOrg?.name ?? ''} 的订阅切换为「${confirmPlan.name}」（${fmtMoney(confirmPlan.monthlyPrice)} / 月）。服务端会生成新订阅与一张发票，金额以发票为准。`
          : ''}
        confirmLabel="确认订阅"
        pending={subscribeMutation.isPending}
        onConfirm={() => confirmPlan && subscribeMutation.mutate(confirmPlan.id)}
      />
    </div>
  );
}
