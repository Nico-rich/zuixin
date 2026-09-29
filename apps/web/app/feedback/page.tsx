'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApiQueryClient } from '@/lib/api';
import {
  feedbackKeys, getPerformanceInsights, listFeedback, listPerformance,
  type CapturePerformanceResult, type FeedbackSubjectType,
} from '@/lib/services/feedback';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { SkeletonLines } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { flattenFacts, fmtCost, fmtDateTime, fmtDecimal, fmtPercent, formatFactValue } from '@/components/metrics-format';
import { SUBJECT_TYPES, subjectTypeLabel } from './components/subject-types';
import { SubmitFeedbackDialog } from './components/submit-feedback-dialog';
import { CapturePerformanceDialog } from './components/capture-performance-dialog';

/**
 * /feedback（M13-W6）——用户反馈 + 创意绩效回流，**分层如实呈现**。
 *
 * 三条口径（写在页面上，不含糊）：
 *  ① 反馈（feedback）= 用户主观评价（JWT + 限流即可提交），不是事实源；
 *  ② 绩效（creativePerformance）= **外部上报事实**（UNTRUSTED；`layering.facts = reported`），
 *     ctr/cvr/roas/cpc 由服务端计算（`service-computed`），页面只展示不自算；
 *  ③ 绩效洞察里的「绩效记忆」是**候选记忆**（memory-candidate），未自动晋级为长期记忆
 *     （M12-P3 的来源可信度闸门在服务端）——页面如实标注，不把它当作已生效结论。
 *
 * 读路径走 F1 service 函数 + service queryKey（不手拼 URL）；写路径见两个 Dialog（useApiMutation）。
 */
export default function FeedbackPage() {
  const queryClient = useApiQueryClient();
  const [subjectFilter, setSubjectFilter] = useState<FeedbackSubjectType | ''>('');
  const [submitOpen, setSubmitOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureResult, setCaptureResult] = useState<CapturePerformanceResult | null>(null);

  const feedback = useQuery({
    queryKey: feedbackKeys.list(subjectFilter ? { subjectType: subjectFilter } : {}),
    queryFn: () => listFeedback(subjectFilter ? { subjectType: subjectFilter } : {}),
  });
  const performance = useQuery({ queryKey: feedbackKeys.performance(), queryFn: () => listPerformance() });
  const insights = useQuery({ queryKey: feedbackKeys.performanceInsights(10), queryFn: () => getPerformanceInsights(10) });

  const invalidateFeedback = () => { void queryClient.invalidateQueries({ queryKey: ['feedback'] }); };
  const invalidatePerformance = () => {
    void queryClient.invalidateQueries({ queryKey: ['feedback-performance'] });
    void queryClient.invalidateQueries({ queryKey: ['feedback-performance-insights'] });
  };

  const feedbackRows = feedback.data?.data ?? [];
  const performanceRows = performance.data?.data ?? [];
  const insightData = insights.data?.data;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">反馈</h1>
          <p className="mt-1 text-xs text-zinc-500">用户反馈（主观评价）· 外部绩效事实（UNTRUSTED）· 服务端派生指标，分层呈现</p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setCaptureOpen(true)}>录入绩效数据</Button>
          <Button type="button" size="sm" onClick={() => setSubmitOpen(true)}>提交反馈</Button>
        </div>
      </div>

      <section data-testid="feedback-list" aria-labelledby="feedback-list-heading" className="mb-8">
        <div className="mb-1 flex items-center gap-2">
          <h2 id="feedback-list-heading" className="text-sm font-medium text-zinc-200">反馈列表</h2>
          <Badge variant="default">用户评价</Badge>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          最近 50 条（createdAt 倒序）。评分/内容是「用户主观评价」，仅供人工参考，不作为事实源或自动治理依据。
        </p>
        <div className="mb-3 flex items-center gap-2">
          <label className="text-xs text-zinc-500" htmlFor="feedback-type-filter">主体类型</label>
          <Select
            id="feedback-type-filter"
            aria-label="主体类型筛选"
            className="h-9 w-56"
            value={subjectFilter}
            onChange={(event) => setSubjectFilter(event.target.value as FeedbackSubjectType | '')}
          >
            <option value="">全部类型</option>
            {SUBJECT_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </Select>
        </div>

        {feedback.isPending && <SkeletonLines lines={3} />}
        {feedback.isError && <p className="p-4 text-sm text-red-400">反馈列表加载失败：{feedback.error.message}</p>}
        {feedback.data && (
          <Card>
            <CardContent className="pt-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>评分</TableHead>
                    <TableHead>主体</TableHead>
                    <TableHead>内容</TableHead>
                    <TableHead>时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {feedbackRows.length === 0 && <TableEmpty colSpan={4}>暂无反馈</TableEmpty>}
                  {feedbackRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap text-xs text-amber-300">★ {row.rating} / 5</TableCell>
                      <TableCell className="text-xs">
                        <span className="block">{subjectTypeLabel(row.subjectType)}</span>
                        <span className="block font-mono text-[10px] text-zinc-500">{row.subjectId}</span>
                      </TableCell>
                      <TableCell className="text-xs text-zinc-300">{row.comment ?? '（无内容）'}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-zinc-500">{fmtDateTime(row.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>

      <section data-testid="performance-list" aria-labelledby="performance-list-heading" className="mb-8">
        <div className="mb-1 flex items-center gap-2">
          <h2 id="performance-list-heading" className="text-sm font-medium text-zinc-200">性能反馈</h2>
          <Badge variant="info">事实</Badge>
          <Badge variant="outline">外部上报</Badge>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          最近 50 条（capturedAt 倒序）：维度（平台 / 制品 / 活动）· 窗口（周期）· 结果（上报原始指标）。
          本列表只呈现「上报原值」；ctr/cvr/roas/cpc 等派生值见下方「绩效洞察」。
        </p>

        {performance.isPending && <SkeletonLines lines={3} />}
        {performance.isError && <p className="p-4 text-sm text-red-400">性能反馈加载失败：{performance.error.message}</p>}
        {performance.data && (
          <Card>
            <CardContent className="pt-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>维度</TableHead>
                    <TableHead>窗口</TableHead>
                    <TableHead>结果（上报事实）</TableHead>
                    <TableHead>捕获时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {performanceRows.length === 0 && <TableEmpty colSpan={4}>暂无绩效数据（可用右上角「录入绩效数据」上报）</TableEmpty>}
                  {performanceRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-xs">
                        <span className="block">{row.platform ?? '未标注平台'}</span>
                        <span className="block font-mono text-[10px] text-zinc-500">
                          {[row.artifactId && `artifact ${row.artifactId}`, row.campaignId && `campaign ${row.campaignId}`, row.adId && `ad ${row.adId}`]
                            .filter(Boolean).join(' · ') || '未关联制品/活动'}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-zinc-400">
                        {row.periodStart ? row.periodStart.slice(0, 10) : '—'} → {row.periodEnd ? row.periodEnd.slice(0, 10) : '—'}
                      </TableCell>
                      <TableCell className="text-xs">
                        {flattenFacts({
                          impressions: row.impressions, clicks: row.clicks, spend: row.spend,
                          conversions: row.conversions, revenue: row.revenue, orders: row.orders,
                        }).map((entry) => `${entry.key} ${formatFactValue(entry.value)}`).join(' · ')}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-zinc-500">{fmtDateTime(row.capturedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>

      <section data-testid="performance-insights" aria-labelledby="performance-insights-heading" className="mb-8">
        <div className="mb-1 flex items-center gap-2">
          <h2 id="performance-insights-heading" className="text-sm font-medium text-zinc-200">绩效洞察</h2>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          左：绩效记忆（「候选」记忆，服务端规则触发，需经人工/受控提升才生效）· 右：近期绩效（服务端派生的 ctr/cvr/roas/cpc）。
        </p>

        {insights.isPending && <SkeletonLines lines={4} />}
        {insights.isError && <p className="p-4 text-sm text-red-400">绩效洞察加载失败：{insights.error.message}</p>}
        {insightData && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  绩效记忆
                  <Badge variant="warning">记忆候选</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {insightData.performanceMemory.length === 0 && <p className="text-xs text-zinc-500">暂无绩效记忆候选</p>}
                {insightData.performanceMemory.map((memory) => (
                  <div key={memory.id} className="rounded-lg border border-zinc-800/80 px-3 py-2">
                    <p className="text-xs text-zinc-200">{memory.content}</p>
                    <p className="mt-1 flex items-center gap-2 text-[10px] text-zinc-500">
                      <Badge variant="secondary">{memory.status}</Badge>
                      <span className="font-mono">source: {memory.source ?? '—'}</span>
                      <span className="font-mono">layering: memory-candidate</span>
                    </p>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  近期绩效
                  <Badge variant="info">事实</Badge>
                  <Badge variant="warning">派生</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {insightData.recentPerformance.length === 0 && <p className="text-xs text-zinc-500">暂无近期绩效</p>}
                {insightData.recentPerformance.map((item) => (
                  <div key={item.performanceId} className="rounded-lg border border-zinc-800/80 px-3 py-2">
                    <p className="font-mono text-[10px] text-zinc-500">
                      {flattenFacts(item.subject).map((entry) => `${entry.key}=${formatFactValue(entry.value)}`).join(' · ') || '未关联主体'}
                    </p>
                    <p className="mt-1 text-xs text-zinc-300">
                      <Badge variant="info" className="mr-1">事实</Badge>
                      {flattenFacts(item.facts).map((entry) => `${entry.key} ${formatFactValue(entry.value)}`).join(' · ')}
                    </p>
                    <p className="mt-1 text-xs text-zinc-400">
                      <Badge variant="warning" className="mr-1">派生</Badge>
                      {derivedLine(item.derived)}
                    </p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}
      </section>

      {captureResult && (
        <section data-testid="capture-result" aria-labelledby="capture-result-heading" className="mb-8">
          <div className="mb-1 flex items-center gap-2">
            <h2 id="capture-result-heading" className="text-sm font-medium text-zinc-200">本次录入结果</h2>
            <Badge variant="outline">口径</Badge>
          </div>
          <p className="mb-3 text-xs text-zinc-500">
            performanceId <span className="font-mono">{captureResult.performanceId}</span> · 分层：
            {flattenFacts(captureResult.layering).map((entry) => `${entry.key}=${formatFactValue(entry.value)}`).join(' · ')}
          </p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2">上报事实<Badge variant="info">事实</Badge></CardTitle></CardHeader>
              <CardContent>
                <dl className="space-y-0.5">
                  {flattenFacts(captureResult.facts).map((entry) => (
                    <div key={entry.key} className="flex justify-between gap-3 border-b border-zinc-800/60 py-1">
                      <dt className="font-mono text-xs text-zinc-500">{entry.key}</dt>
                      <dd className="text-xs text-zinc-200">{formatFactValue(entry.value)}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2">服务端派生<Badge variant="warning">派生</Badge></CardTitle></CardHeader>
              <CardContent>
                <dl className="space-y-0.5">
                  {flattenFacts(captureResult.derived).map((entry) => (
                    <div key={entry.key} className="flex justify-between gap-3 border-b border-zinc-800/60 py-1">
                      <dt className="font-mono text-xs text-zinc-500">{entry.key}</dt>
                      <dd className="text-xs text-zinc-200">{derivedDisplay(entry.key, entry.value)}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          </div>
        </section>
      )}

      <p className="text-[11px] text-zinc-600">
        口径：绩效事实入口是「外部上报」通道（UNTRUSTED），服务端仅据此计算比率指标；创意效果的自证判定另有来源判别（external-only），
        页面不提供任何「用上报数据反向影响策略/记忆晋级」的入口。
      </p>

      <SubmitFeedbackDialog
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        onSubmitted={() => invalidateFeedback()}
      />
      <CapturePerformanceDialog
        open={captureOpen}
        onOpenChange={setCaptureOpen}
        onCaptured={(result) => { setCaptureResult(result); invalidatePerformance(); }}
      />
    </div>
  );
}

/** 派生比率行的展示（ctr/cvr 为比率 → 百分比；roas 为倍数；cpc 为金额） */
function derivedLine(derived: unknown): string {
  return flattenFacts(derived).map((entry) => `${entry.key} ${derivedDisplay(entry.key, entry.value)}`).join(' · ') || '—';
}

function derivedDisplay(key: string, value: unknown): string {
  if (typeof value !== 'number') return formatFactValue(value);
  if (key === 'ctr' || key === 'cvr') return fmtPercent(value);
  if (key === 'cpc') return fmtCost(value);
  if (key === 'roas') return `${fmtDecimal(value, 2)}x`;
  return fmtDecimal(value, 4);
}
