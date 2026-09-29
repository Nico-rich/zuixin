'use client';

import { useState } from 'react';
import { Info } from 'lucide-react';
import { useApiQuery } from '@/lib/api';
import {
  CommerceAnalysisDetail, CommerceAnalysisListItem, CreativeBriefDetail, CreativeBriefListItem,
  commerceKeys,
} from '@/lib/services/commerce';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SkeletonLines } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * /ecommerce —— 电商只读展示（分析 / 创意简报）（M13-W9）
 *
 * **产品口径（页面必须如实标注）**：工具即接口——电商域的写路径（采集 / 分析 / 建简报）
 * 全部由 Agent 工具执行并落在 ToolCall 幂等账本里；本页没有任何写操作入口
 * （后端同面无 POST/PATCH/DELETE 端点）。
 *
 * **分层红线**：`facts / derived / anomalies = 服务端计算`，
 * `possibleCauses / recommendations = LLM 推测`（响应里的 `layering` 是服务端标注）。
 * 页面按层分块呈现，**绝不把推测渲染成事实**，也不隐藏 source 标注。
 */

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

function rangeLabel(range: { start?: string; end?: string; days?: number } | null): string {
  if (!range) return '—';
  if (range.days) return `近 ${range.days} 天`;
  if (range.start && range.end) return `${range.start} ~ ${range.end}`;
  return '—';
}

function LayeredBlock({ label, note, value, tone }: {
  label: string; note: string; value: unknown; tone: 'fact' | 'guess';
}) {
  if (value === null || value === undefined) return null;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <p className="mb-1 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-300">{label}</span>
        <Badge variant={tone === 'fact' ? 'success' : 'warning'}>
          {tone === 'fact' ? '服务端计算' : 'LLM 推测'}
        </Badge>
        <span className="text-zinc-500">{note}</span>
      </p>
      <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-200">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default function EcommercePage() {
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [briefId, setBriefId] = useState<string | null>(null);

  const analyses = useApiQuery<{ data: CommerceAnalysisListItem[] }>({
    queryKey: commerceKeys.analyses,
    path: '/api/v1/commerce/analyses',
  });
  const briefs = useApiQuery<{ data: CreativeBriefListItem[] }>({
    queryKey: commerceKeys.briefs,
    path: '/api/v1/commerce/briefs',
  });
  const analysisDetail = useApiQuery<{ data: CommerceAnalysisDetail }>({
    queryKey: commerceKeys.analysis(analysisId ?? ''),
    path: `/api/v1/commerce/analyses/${encodeURIComponent(analysisId ?? '')}`,
    enabled: analysisId !== null,
  });
  const briefDetail = useApiQuery<{ data: CreativeBriefDetail }>({
    queryKey: commerceKeys.brief(briefId ?? ''),
    path: `/api/v1/commerce/briefs/${encodeURIComponent(briefId ?? '')}`,
    enabled: briefId !== null,
  });

  const analysisRows = analyses.data?.data ?? [];
  const briefRows = briefs.data?.data ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-zinc-100">电商</h1>
        <span className="text-xs text-zinc-500">只读展示 · 分析/简报由 Agent 工具产出</span>
      </div>

      <p className="mb-6 flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          <strong className="font-medium text-zinc-300">工具即接口</strong>：采集数据、生成分析、创建创意简报
          都由 Agent 工具执行（带幂等账本）；本页只把既有结果读出来展示，不提供任何写操作。
          分析与简报的事实层由服务端计算，推测/建议层来自 LLM 并已标注来源，两层不得混同。
        </span>
      </p>

      <Tabs defaultValue="analyses">
        <TabsList aria-label="电商视图">
          <TabsTrigger value="analyses">分析</TabsTrigger>
          <TabsTrigger value="briefs">创意简报</TabsTrigger>
        </TabsList>

        <TabsContent value="analyses">
          {analyses.isPending && <SkeletonLines lines={3} />}
          {analyses.isError && <p className="text-sm text-red-400">分析列表加载失败：{analyses.error.message}</p>}
          {!analyses.isPending && !analyses.isError && analysisRows.length === 0 && (
            <p className="py-10 text-center text-sm text-zinc-500">还没有分析结果（可由 Agent 的 commerce.analysis.generate 工具生成）</p>
          )}
          <ul className="space-y-2">
            {analysisRows.map((a) => (
              <li key={a.analysisId}>
                <Card data-testid={`analysis-${a.analysisId}`}>
                  <CardHeader className="flex-row items-center justify-between gap-3">
                    <CardTitle className="min-w-0 flex-1 truncate">{a.analysisType}</CardTitle>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge variant="secondary">{rangeLabel(a.timeRange)}</Badge>
                      <Badge variant="success">{a.status}</Badge>
                    </span>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <p className="text-xs text-zinc-500">
                      生成于 {fmt(a.createdAt)}{a.agentRunId ? ` · 运行 ${a.agentRunId}` : ''}
                    </p>
                    <Button size="sm" variant="outline" onClick={() => setAnalysisId(a.analysisId)}>查看分层详情</Button>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </TabsContent>

        <TabsContent value="briefs">
          {briefs.isPending && <SkeletonLines lines={3} />}
          {briefs.isError && <p className="text-sm text-red-400">简报列表加载失败：{briefs.error.message}</p>}
          {!briefs.isPending && !briefs.isError && briefRows.length === 0 && (
            <p className="py-10 text-center text-sm text-zinc-500">还没有创意简报（可由 Agent 的 commerce.brief.create 工具创建）</p>
          )}
          <ul className="space-y-2">
            {briefRows.map((b) => (
              <li key={b.briefId}>
                <Card data-testid={`brief-${b.briefId}`}>
                  <CardHeader className="flex-row items-center justify-between gap-3">
                    <CardTitle className="min-w-0 flex-1 truncate" title={b.problem}>{b.problem}</CardTitle>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge variant="secondary">{b.platform ?? '未指定平台'}</Badge>
                      <Badge variant="success">{b.status}</Badge>
                    </span>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <p className="text-sm text-zinc-400">目标：{b.objective}</p>
                    <p className="text-xs text-zinc-500">
                      创建于 {fmt(b.createdAt)}
                      {b.analysisId ? ` · 证据来源分析 ${b.analysisId}` : ' · 无证据快照'}
                      {b.artifactId ? ' · 已镜像到制品库' : ''}
                    </p>
                    <Button size="sm" variant="outline" onClick={() => setBriefId(b.briefId)}>查看简报详情</Button>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </TabsContent>
      </Tabs>

      <Dialog open={analysisId !== null} onOpenChange={(open) => { if (!open) setAnalysisId(null); }}>
        <DialogHeader>
          <DialogTitle>分析详情（{analysisDetail.data?.data.analysisType ?? '…'}）</DialogTitle>
          <DialogDescription>
            事实层与推测层分块呈现：标注来自服务端 `layering`，页面不改写。
          </DialogDescription>
        </DialogHeader>
        <DialogContent className="space-y-2">
          {analysisDetail.isPending && <SkeletonLines lines={4} />}
          {analysisDetail.isError && <p className="text-sm text-red-400">详情加载失败：{analysisDetail.error.message}</p>}
          {analysisDetail.data && (
            <>
              <LayeredBlock label="事实（facts）" note="原始聚合，服务端快照" value={analysisDetail.data.data.facts} tone="fact" />
              <LayeredBlock label="派生指标（derived）" note="服务端计算" value={analysisDetail.data.data.derived} tone="fact" />
              <LayeredBlock label="规则异常（anomalies）" note="服务端阈值规则，不是 LLM 判断" value={analysisDetail.data.data.anomalies} tone="fact" />
              <LayeredBlock label="可能原因（possibleCauses）" note="LLM 解读，仅供假设" value={analysisDetail.data.data.possibleCauses} tone="guess" />
              <LayeredBlock label="建议（recommendations）" note="LLM 建议，需人工判断" value={analysisDetail.data.data.recommendations} tone="guess" />
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={briefId !== null} onOpenChange={(open) => { if (!open) setBriefId(null); }}>
        <DialogHeader>
          <DialogTitle>{briefDetail.data?.data.problem ?? '创意简报'}</DialogTitle>
          <DialogDescription>
            简报的 problem/objective 由人给出；创意方向为 LLM 建议；evidence 是分析事实的快照。
          </DialogDescription>
        </DialogHeader>
        <DialogContent className="space-y-2">
          {briefDetail.isPending && <SkeletonLines lines={4} />}
          {briefDetail.isError && <p className="text-sm text-red-400">详情加载失败：{briefDetail.error.message}</p>}
          {briefDetail.data && (
            <>
              <dl className="space-y-1 text-xs text-zinc-300">
                <div className="flex gap-2"><dt className="w-20 shrink-0 text-zinc-500">目标</dt><dd className="min-w-0 flex-1">{briefDetail.data.data.objective}</dd></div>
                <div className="flex gap-2"><dt className="w-20 shrink-0 text-zinc-500">平台</dt><dd className="min-w-0 flex-1">{briefDetail.data.data.platform ?? '—'}</dd></div>
                <div className="flex gap-2"><dt className="w-20 shrink-0 text-zinc-500">状态</dt><dd className="min-w-0 flex-1">{briefDetail.data.data.status}</dd></div>
                {briefDetail.data.data.target && (
                  <div className="flex gap-2"><dt className="w-20 shrink-0 text-zinc-500">目标人群</dt><dd className="min-w-0 flex-1">{briefDetail.data.data.target}</dd></div>
                )}
              </dl>
              <LayeredBlock label="创意角度（creativeAngle）" note="LLM 建议" value={briefDetail.data.data.creativeAngle} tone="guess" />
              <LayeredBlock label="视觉方向（visualDirection）" note="LLM 建议" value={briefDetail.data.data.visualDirection} tone="guess" />
              <LayeredBlock label="文案方向（copyDirection）" note="LLM 建议" value={briefDetail.data.data.copyDirection} tone="guess" />
              <LayeredBlock label="数据证据（evidence）" note="分析事实快照（来源可追溯）" value={briefDetail.data.data.evidence} tone="fact" />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
