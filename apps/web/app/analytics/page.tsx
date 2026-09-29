'use client';

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApiMutation, useApiQueryClient } from '@/lib/api';
// 注：读端点集中在 F1 service 层（含 apiFetchWithMeta 的分页端点），因此读路径用
// useQuery(queryKey = service 的 key 工厂, queryFn = service 函数)——不手拼 URL；写路径用 useApiMutation。
import {
  analyticsKeys, getAnalyticsBreakdown, getAnalyticsOverview, getAnalyticsSources, refreshAnalytics,
  type AnalyticsKind, type AnalyticsOverview, type AnalyticsRange,
} from '@/lib/services/analytics';
import { listOrganizations, organizationKeys } from '@/lib/services/organizations';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SkeletonLines } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  flattenFacts, fmtCost, fmtDateTime, fmtDecimal, fmtDurationMs, fmtInt, fmtPercent, formatFactValue,
} from '@/components/metrics-format';

/**
 * /analytics（M13-W6）——组织级确定性聚合的**如实分层**呈现。
 *
 * 红线（M12/M13 §4 + F1 契约 analytics.ts）：响应固定分三层，
 *   - `facts`   = 事务表的确定性投影（AnalyticsAggregate 聚合行）→ 本页 Badge「事实」，原始键值直出；
 *   - `derived` = 服务端计算（成功率/均值/人均成本…）→ 本页 Badge「派生」，**派生值不是事实源**；
 *   - `meta`    = 来源与新鲜度（source / refreshedAt / rows / layering）→ 本页 Badge「口径」。
 * 三个区**绝不混排**：事实区只放 facts 原值，派生区只放服务端派生值，口径区只放口径元信息。
 * 页面自身**不做任何计算**（连求和都不做）——数字全部来自服务端响应。
 *
 * 读路径：一律走 F1 service 函数（`getAnalytics*`）+ service 提供的 queryKey；
 * 不手拼 URL（HTTP 契约的单一事实源是 lib/services + test/services.test.ts，页面不复制一份）。
 * 写路径：`refreshAnalytics` 经 `useApiMutation`（该端点是 owner 专属 billing.write，权限由服务端裁决）。
 */

const RANGE_LABEL: Record<AnalyticsRange, string> = { day: '当日', week: '近 7 天', month: '近 30 天' };
const RANGES: AnalyticsRange[] = ['day', 'week', 'month'];

const KIND_LABEL: Record<AnalyticsKind, string> = {
  usage: '用量账本',
  agent: 'Agent 运行',
  generation: '生成任务',
  provider: 'Provider 调用',
  workflow: '工作流运行',
};
const KINDS: AnalyticsKind[] = ['usage', 'agent', 'generation', 'provider', 'workflow'];

/** 区间天数候选（后端 days 上限 366；这里只给常用窗口） */
const DAY_OPTIONS = [7, 30, 90, 180, 366];

type Layer = 'facts' | 'derived' | 'meta';

const LAYER_LABEL: Record<Layer, string> = { facts: '事实', derived: '派生', meta: '口径' };
const LAYER_BADGE: Record<Layer, 'info' | 'warning' | 'outline'> = { facts: 'info', derived: 'warning', meta: 'outline' };

const LAYER_NOTE: Record<Layer, string> = {
  facts: '来自事务表的确定性投影（后端聚合行原始键值，未经任何加工、解读或换算）。',
  derived: '由服务端计算得出，仅供展示参考——派生值不是事实源，本页不参与、也不改写任何计算。',
  meta: '数据来源与新鲜度口径（source / refreshedAt / rows / layering）。历史日期按刷新时点冻结，只有「当日」随读写实时重算。',
};

function LayerSection({ layer, title, children }: { layer: Layer; title: string; children: ReactNode }) {
  const headingId = `analytics-${layer}-heading`;
  return (
    <section data-testid={`analytics-${layer}`} aria-labelledby={headingId} className="mb-8">
      <div className="mb-1 flex items-center gap-2">
        <h2 id={headingId} className="text-sm font-medium text-zinc-200">{title}</h2>
        <Badge variant={LAYER_BADGE[layer]}>{LAYER_LABEL[layer]}</Badge>
      </div>
      <p className="mb-3 text-xs text-zinc-500">{LAYER_NOTE[layer]}</p>
      {children}
    </section>
  );
}

/**
 * breakdown 的 `meta` 在 F1 契约里是 `unknown`（后端同一 meta 形状，但类型未细化到字段）。
 * 这里做一次**显式收窄 + 缺省兜底**：形状不符时显示占位，绝不把 unknown 直接渲染成 `[object Object]`。
 */
interface AggregateMeta { rows?: number; refreshedAt?: string | null; source?: string[] }

function narrowAggregateMeta(value: unknown): Required<Pick<AggregateMeta, 'source'>> & AggregateMeta {
  const meta = (value ?? {}) as AggregateMeta;
  return {
    rows: typeof meta.rows === 'number' ? meta.rows : undefined,
    refreshedAt: typeof meta.refreshedAt === 'string' ? meta.refreshedAt : null,
    source: Array.isArray(meta.source) ? meta.source.filter((item): item is string => typeof item === 'string') : [],
  };
}

/** facts 渲染：点分键 + 原值直出（数字只做展示格式化，不做任何计算） */
function FactList({ label, value }: { label?: string; value: unknown }) {
  const entries = flattenFacts(value);
  if (entries.length === 0) return <p className="text-xs text-zinc-500">暂无聚合行</p>;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
      {label && <div className="sm:col-span-2 pb-1 text-xs text-zinc-500">{label}</div>}
      {entries.map((entry) => (
        <div key={entry.key} className="flex items-baseline justify-between gap-3 border-b border-zinc-800/60 py-1">
          <dt className="min-w-0 truncate font-mono text-xs text-zinc-500" title={entry.key}>{entry.key}</dt>
          <dd className="shrink-0 text-xs text-zinc-200">{formatFactValue(entry.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 派生指标展示表：label（中文）+ 服务端字段名 + 展示值（格式化函数只影响呈现） */
const DERIVED_ROWS: Array<{ key: keyof AnalyticsOverview['derived']; label: string; format: (value: number) => string }> = [
  { key: 'totalCost', label: '总成本', format: fmtCost },
  { key: 'providerCost', label: 'Provider 成本', format: fmtCost },
  { key: 'llmCost', label: 'LLM 成本', format: fmtCost },
  { key: 'costPerRun', label: '单次运行成本', format: fmtCost },
  { key: 'costPerMember', label: '人均成本', format: fmtCost },
  { key: 'costPerDay', label: '日均成本', format: fmtCost },
  { key: 'runSuccessRate', label: 'Run 成功率', format: fmtPercent },
  { key: 'workflowSuccessRate', label: '工作流成功率', format: fmtPercent },
  { key: 'avgRunDurationMs', label: '平均 Run 时长', format: fmtDurationMs },
  { key: 'runsPerDay', label: '日均 Run 数', format: (v) => fmtDecimal(v, 2) },
  { key: 'imagesPerDay', label: '日均出图', format: (v) => fmtDecimal(v, 2) },
];

function DerivedGrid({ derived }: { derived: AnalyticsOverview['derived'] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {DERIVED_ROWS.map((row) => (
        <Card key={row.key}>
          <CardContent className="py-2">
            <p className="text-xs text-zinc-400">{row.label}</p>
            <p className="mt-1 text-lg font-semibold text-zinc-100">{row.format(derived[row.key])}</p>
            <p className="mt-0.5 font-mono text-[10px] text-zinc-600">{row.key}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function MetaList({ entries }: { entries: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
      {entries.map((entry) => (
        <div key={entry.label} className="flex items-baseline justify-between gap-3 border-b border-zinc-800/60 py-1">
          <dt className="min-w-0 truncate text-xs text-zinc-500">{entry.label}</dt>
          <dd className="shrink-0 text-right text-xs text-zinc-300">{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function AnalyticsPage() {
  const { toast } = useToast();
  const queryClient = useApiQueryClient();

  const [range, setRange] = useState<AnalyticsRange>('day');
  const [kind, setKind] = useState<AnalyticsKind>('usage');
  const [days, setDays] = useState(30);
  const [period, setPeriod] = useState('');

  const overview = useQuery({ queryKey: analyticsKeys.overview(undefined, range), queryFn: () => getAnalyticsOverview({ range }) });
  const breakdown = useQuery({ queryKey: analyticsKeys.breakdown({ kind, days }), queryFn: () => getAnalyticsBreakdown({ kind, days }) });
  const sources = useQuery({ queryKey: analyticsKeys.sources(undefined, period || undefined), queryFn: () => getAnalyticsSources(period ? { period } : {}) });
  // 组织角色只为「如实显示刷新权限」：写端点服务端仍会再判一次（billing.write = owner）
  const organizations = useQuery({ queryKey: organizationKeys.all, queryFn: listOrganizations });

  const organizationId = overview.data?.data.organizationId;
  const role = organizationId
    ? organizations.data?.data.find((org) => org.id === organizationId)?.members[0]?.role
    : undefined;
  const canRefresh = role === undefined || role === 'owner';

  const refresh = useApiMutation(refreshAnalytics, {
    onSuccess: (response) => {
      const { from, to, days: spanDays, periods } = response.data;
      toast({ title: '聚合刷新完成', description: `${from} → ${to}（${spanDays} 天 / ${periods.length} 个周期）`, variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['analytics-overview'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics-breakdown'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics-sources'] });
    },
    onError: (error) => {
      toast({
        title: '刷新失败',
        description: error.code === 'FORBIDDEN' ? `${error.message}（手动刷新为组织 owner 专属：billing.write）` : error.message,
        variant: 'error',
      });
    },
  });

  const data = overview.data?.data;
  const meta = data?.meta;
  const breakdownData = breakdown.data?.data;
  const breakdownMeta = narrowAggregateMeta(breakdownData?.meta);
  const sourcesData = sources.data?.data;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">分析</h1>
          <p className="mt-1 text-xs text-zinc-500">组织级聚合 · 事实 / 派生 / 口径分层呈现 · 页面不做任何计算</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <label className="text-xs text-zinc-500" htmlFor="analytics-range">区间</label>
            <Select
              id="analytics-range"
              aria-label="统计区间"
              className="h-9 w-28"
              value={range}
              onChange={(event) => setRange(event.target.value as AnalyticsRange)}
            >
              {RANGES.map((value) => <option key={value} value={value}>{RANGE_LABEL[value]}</option>)}
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={refresh.isPending || !canRefresh}
              onClick={() => refresh.mutate({})}
            >
              {refresh.isPending ? '刷新中…' : '手动刷新聚合'}
            </Button>
          </div>
          <p className="text-[11px] text-zinc-600">
            {role === undefined
              ? '手动刷新需要组织 owner 权限（billing.write）；无权限时服务端返回 403。'
              : `当前组织角色：${role}${role === 'owner' ? '（可手动刷新）' : '（无 billing.write，服务端将拒绝刷新）'}`}
          </p>
        </div>
      </div>

      {overview.isPending && <p className="py-8 text-sm text-zinc-500">加载中…</p>}
      {overview.isError && <p className="p-4 text-sm text-red-400">分析总览加载失败：{overview.error.message}</p>}

      {data && meta && (
        <>
          <LayerSection layer="facts" title="事实 · 原始聚合数据">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {KINDS.map((value) => (
                <Card key={value}>
                  <CardHeader>
                    <CardTitle>{KIND_LABEL[value]}<span className="ml-2 font-mono text-[10px] font-normal text-zinc-600">{value}</span></CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <FactList value={data.facts[value] ?? {}} />
                  </CardContent>
                </Card>
              ))}
            </div>
          </LayerSection>

          <LayerSection layer="derived" title="派生 · 服务端计算">
            <DerivedGrid derived={data.derived} />
          </LayerSection>

          <LayerSection layer="meta" title="口径 · 来源与新鲜度">
            <Card>
              <CardContent>
                <MetaList
                  entries={[
                    { label: '组织', value: <span className="font-mono">{data.organizationId}</span> },
                    { label: '区间定义', value: <span className="font-mono">{RANGE_LABEL[data.range]}：{data.from} → {data.to}（{data.days} 天）</span> },
                    { label: '聚合行数 rows', value: fmtInt(meta.rows) },
                    { label: '最近刷新 refreshedAt', value: meta.refreshedAt ? fmtDateTime(meta.refreshedAt) : '未刷新（无聚合行）' },
                    { label: '事实来源 source', value: meta.source.length > 0 ? meta.source.join('、') : '—' },
                    { label: '组织成员数 context.members', value: fmtInt(data.context.members) },
                  ]}
                />
                <div className="mt-3">
                  <p className="mb-1 text-xs text-zinc-500">分层口径 layering</p>
                  <FactList value={meta.layering} />
                </div>
              </CardContent>
            </Card>
          </LayerSection>
        </>
      )}

      <section data-testid="analytics-breakdown" aria-labelledby="analytics-breakdown-heading" className="mb-8">
        <div className="mb-1 flex items-center gap-2">
          <h2 id="analytics-breakdown-heading" className="text-sm font-medium text-zinc-200">分类明细</h2>
          <Badge variant="info">事实</Badge>
        </div>
        <p className="mb-3 text-xs text-zinc-500">逐日聚合行（每行可追溯到唯一事务表 source）。表内数字为聚合行原值；区间合计见下方「区间合计」。</p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select aria-label="明细维度" className="h-9 w-40" value={kind} onChange={(event) => setKind(event.target.value as AnalyticsKind)}>
            {KINDS.map((value) => <option key={value} value={value}>{KIND_LABEL[value]}</option>)}
          </Select>
          <Select aria-label="明细天数" className="h-9 w-32" value={String(days)} onChange={(event) => setDays(Number(event.target.value))}>
            {DAY_OPTIONS.map((value) => <option key={value} value={String(value)}>近 {value} 天</option>)}
          </Select>
        </div>

        {breakdown.isPending && <SkeletonLines lines={4} />}
        {breakdown.isError && <p className="p-4 text-sm text-red-400">分类明细加载失败：{breakdown.error.message}</p>}
        {breakdownData && (
          <Card>
            <CardContent className="pt-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>日期</TableHead>
                    <TableHead>维度</TableHead>
                    <TableHead>来源</TableHead>
                    <TableHead>指标（原值）</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {breakdownData.series.length === 0 && <TableEmpty colSpan={4}>该区间暂无聚合行</TableEmpty>}
                  {breakdownData.series.map((row) => (
                    <TableRow key={`${row.period}-${row.kind}`}>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{row.period}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{KIND_LABEL[row.kind as AnalyticsKind] ?? row.kind}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-zinc-500">{row.source}</TableCell>
                      <TableCell className="text-xs">
                        {flattenFacts(row.metrics).map((entry) => `${entry.key} ${formatFactValue(entry.value)}`).join(' · ') || '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs text-zinc-500">区间合计 facts（{breakdownData.from} → {breakdownData.to}）</p>
                  <FactList value={breakdownData.facts} />
                </div>
                <div>
                  <p className="mb-1 text-xs text-zinc-500">口径 meta</p>
                  <MetaList
                    entries={[
                      { label: '天数 days', value: fmtInt(breakdownData.days) },
                      { label: '聚合行数 rows', value: breakdownMeta.rows === undefined ? '—' : fmtInt(breakdownMeta.rows) },
                      { label: '最近刷新 refreshedAt', value: breakdownMeta.refreshedAt ? fmtDateTime(breakdownMeta.refreshedAt) : '未刷新' },
                      { label: '事实来源 source', value: breakdownMeta.source.length > 0 ? breakdownMeta.source.join('、') : '—' },
                    ]}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </section>

      <section data-testid="analytics-sources" aria-labelledby="analytics-sources-heading" className="mb-8">
        <div className="mb-1 flex items-center gap-2">
          <h2 id="analytics-sources-heading" className="text-sm font-medium text-zinc-200">数据源</h2>
          <Badge variant="outline">口径</Badge>
        </div>
        <p className="mb-3 text-xs text-zinc-500">某一日（UTC period）每个维度落有哪些聚合行、来自哪张事务表、作用域是组织级还是用户级。</p>
        <div className="mb-3 flex items-center gap-2">
          <label className="text-xs text-zinc-500" htmlFor="analytics-period">日期（留空 = 今天）</label>
          <Input
            id="analytics-period"
            aria-label="数据源日期"
            type="date"
            className="h-9 w-44"
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
          />
        </div>

        {sources.isPending && <SkeletonLines lines={3} />}
        {sources.isError && <p className="p-4 text-sm text-red-400">数据源加载失败：{sources.error.message}</p>}
        {sourcesData && (
          <Card>
            <CardContent className="pt-3">
              <p className="mb-2 text-xs text-zinc-500">
                period <span className="font-mono text-zinc-300">{sourcesData.period}</span> · 聚合行 {fmtInt(sourcesData.count)} 条
              </p>
              <p className="mb-1 text-xs text-zinc-500">维度 → 事务来源映射（kindSourceMap）</p>
              <FactList value={sourcesData.kindSourceMap} />
              <div className="mt-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>维度</TableHead>
                      <TableHead>来源表</TableHead>
                      <TableHead>作用域</TableHead>
                      <TableHead>指标键</TableHead>
                      <TableHead>刷新时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sourcesData.sources.length === 0 && <TableEmpty colSpan={5}>该日暂无聚合行</TableEmpty>}
                    {sourcesData.sources.map((row) => (
                      <TableRow key={`${row.kind}-${row.source}`}>
                        <TableCell className="whitespace-nowrap text-xs">{KIND_LABEL[row.kind as AnalyticsKind] ?? row.kind}</TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs text-zinc-500">{row.source}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{row.scope === 'organization' ? '组织级' : '用户级'}</TableCell>
                        <TableCell className="font-mono text-xs text-zinc-400">
                          {Array.isArray(row.metricKeys) ? (row.metricKeys as string[]).join(' · ') : formatFactValue(row.metricKeys)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(row.refreshedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="mt-2 text-[11px] text-zinc-600">
                分层口径：facts=deterministic-projection · derived=service-computed · interpretation=none（后端不做任何 LLM 解读）
              </p>
            </CardContent>
          </Card>
        )}
      </section>

      <p className="text-[11px] text-zinc-600">
        口径说明：区间末日的数字随读写实时重算，历史日期按刷新时点冻结；需要历史区间最新数字时用「手动刷新聚合」（owner）。
        组织级账本口径见账单页（UsageLedgerEntry 账本）。
      </p>
    </div>
  );
}
