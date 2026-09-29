'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SkeletonLines } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { useApiMutation, useApiQuery, useApiQueryClient } from '@/lib/api';
import {
  creativeKeys, getInsight, interpretInsight, listHypotheses, type HypothesisView, type InsightView,
} from '@/lib/services/creative';
import {
  ActionError, EmptyState, FactsHashLine, FieldRow, Hint, HypothesisStatusCell, KeyValuePairs, LayerBadge,
  LayerSection, TextBlock, ValueView,
} from '../../components/creative-ui';
import {
  asView, formatDateTime, shortId, windowLabel,
  type InsightComparisonEntry, type InsightDerivedShape, type InsightFactsShape, type InsightInterpretationShape,
  type InsightLayeringShape,
} from '../../components/creative-view';

/**
 * M13-W4 洞察详情（/creative/insights/[id]）
 *
 * 三层分区如实展示（**这是本页的全部意义**）：
 *  - 事实层 facts：服务端对回流原始行的求和（只读聚合）；
 *  - 派生层 derived：服务端按公式派生（绝不含 LLM 文本）；
 *  - 解读层 interpretation：LLM 文本，独立字段与独立写入路径，写入前 `assertFactsUnchanged` +
 *    `factsHash` 条件更新双保险——**事实层绝不被解读改写**（页面把该锚点原样展示给使用者）。
 * 另有「引用该洞察的假设」列表：只做**客户端过滤**（后端列表端点无 insightId 参数），页面明确标注该口径。
 */

/** 单条解读长度上限（后端 InterpretationSchema：items[].max(500)、数组 1~10） */
const ITEM_MAX = 500;
const ITEM_COUNT_MAX = 10;

export default function InsightDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const queryClient = useApiQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [itemsText, setItemsText] = useState('');
  const [model, setModel] = useState('');
  const [formError, setFormError] = useState('');

  const insightQuery = useApiQuery<{ data: InsightView }>({
    queryKey: creativeKeys.insight(id),
    path: `/api/v1/creative-loop/insights/${id}`,
  });
  const insight = insightQuery.data?.data ?? null;

  const facts = asView<InsightFactsShape>(insight?.facts);
  const derived = asView<InsightDerivedShape>(insight?.derived);
  const interpretation = asView<InsightInterpretationShape | null>(insight?.interpretation);
  const layering = asView<InsightLayeringShape>(insight?.layering);

  // 引用该洞察的假设：按洞察所属组织拉取列表后**客户端过滤**（后端不支持 insightId 查询参数——如实标注）
  const hypothesesQuery = useApiQuery<{ data: { hypotheses: HypothesisView[] } }>({
    queryKey: creativeKeys.hypotheses({ organizationId: insight?.organizationId, limit: 100 }),
    path: `/api/v1/creative-loop/hypotheses?limit=100&organizationId=${encodeURIComponent(insight?.organizationId ?? '')}`,
    enabled: Boolean(insight?.organizationId),
  });
  const referencing = (hypothesesQuery.data?.data.hypotheses ?? []).filter((h) => h.insightId === id);

  const interpretMutation = useApiMutation(
    (input: { items: string[]; model?: string }) => interpretInsight(id, { items: input.items, model: input.model ?? null }),
    {
      onSuccess: () => {
        setOpen(false);
        setItemsText('');
        setModel('');
        setFormError('');
        toast({ title: '解读已写入', description: 'LLM 解读层独立于事实层（facts/derived 未被改写）', variant: 'success' });
        void queryClient.invalidateQueries({ queryKey: creativeKeys.insight(id) });
      },
      onError: (error) => setFormError(error.message),
    },
  );

  const submitInterpretation = () => {
    const items = itemsText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    if (items.length === 0) {
      setFormError('至少输入一条解读要点');
      return;
    }
    if (items.length > ITEM_COUNT_MAX) {
      setFormError(`解读要点最多 ${ITEM_COUNT_MAX} 条`);
      return;
    }
    const tooLong = items.find((item) => item.length > ITEM_MAX);
    if (tooLong) {
      setFormError(`单条解读不超过 ${ITEM_MAX} 字`);
      return;
    }
    setFormError('');
    interpretMutation.mutate({ items, ...(model.trim() ? { model: model.trim() } : {}) });
  };

  if (insightQuery.isLoading) {
    return <div className="mx-auto max-w-4xl px-4 py-8"><SkeletonLines lines={4} /></div>;
  }
  if (insightQuery.error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <p className="text-sm text-red-400">洞察加载失败：{insightQuery.error.message}</p>
        <Link href="/creative" className="mt-4 inline-block text-xs text-zinc-400 hover:text-zinc-100">← 返回创意工作台</Link>
      </div>
    );
  }
  if (!insight) return null;

  const comparison: InsightComparisonEntry[] = derived?.comparison ?? [];
  const metrics = derived?.metrics ?? {};
  const baseline = derived?.baseline ?? {};

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/creative" className="text-xs text-zinc-500 hover:text-zinc-300">← 创意工作台</Link>

      <div className="mt-4 mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">洞察快照</h1>
          <p className="mt-1 text-xs text-zinc-500">{windowLabel(insight.window)}</p>
        </div>
        <div className="flex items-center gap-1">
          <LayerBadge layer="facts" />
          <LayerBadge layer="derived" />
          <LayerBadge layer="interpretation" />
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
        <FieldRow label="洞察 ID"><code className="break-all font-mono text-[11px]">{insight.id}</code></FieldRow>
        <FieldRow label="组织 / 项目">
          <code className="font-mono text-[11px]">{shortId(insight.organizationId)}</code>
          <span className="mx-1 text-zinc-600">/</span>
          <code className="font-mono text-[11px]">{insight.projectId ? shortId(insight.projectId) : '全量（无项目限定）'}</code>
        </FieldRow>
        <FieldRow label="筛选条件">
          <code className="break-all font-mono text-[11px]">{JSON.stringify(insight.filters ?? null)}</code>
        </FieldRow>
        <FieldRow label="创建 / 更新">{formatDateTime(insight.createdAt)} / {formatDateTime(insight.updatedAt)}</FieldRow>
      </div>

      <div className="mb-4"><FactsHashLine hash={insight.factsHash} /></div>

      <div className="space-y-4">
        <LayerSection
          layer="facts"
          source={layering?.facts}
          description="回流原始事实的聚合（曝光/点击/花费/转化/营收/订单、评分计数、评测 run 摘要）——只由服务端 insight-rules 求和。"
        >
          <KeyValuePairs pairs={[
            ...Object.entries(facts?.performance?.current ?? {}).map(([k, v]) => [`绩效.${k}`, String(v)] as [string, string]),
            ...(typeof facts?.ratings?.count === 'number' ? [['评分条数', String(facts.ratings.count)] as [string, string]] : []),
            ...(typeof facts?.ratings?.avgRating === 'number' ? [['平均分', String(facts.ratings.avgRating)] as [string, string]] : []),
          ]} />
          {facts?.window && (
            <p className="mt-3 text-[11px] text-zinc-500">窗口 start/end（服务端落窗）：{facts.window.start} → {facts.window.end}</p>
          )}
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-zinc-500">完整事实层（原始 JSON，如实呈现）</summary>
            <div className="mt-2"><ValueView value={insight.facts} /></div>
          </details>
        </LayerSection>

        <LayerSection
          layer="derived"
          source={layering?.derived}
          description="服务端按公式派生（ctr/cvr/roas/cpc、环比对比、评分汇总、评测聚合）——绝不含 LLM 文本。"
        >
          <KeyValuePairs pairs={[
            ...Object.entries(metrics).map(([k, v]) => [`当期.${k}`, String(v)] as [string, string]),
            ...Object.entries(baseline).map(([k, v]) => [`前一期.${k}`, String(v)] as [string, string]),
          ]} />
          {comparison.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-xs text-zinc-500">环比对比（规则 {comparison[0]?.rule ?? 'server-comparison'}；阈值内不标异常）</div>
              <ul className="space-y-1">
                {comparison.map((entry) => (
                  <li key={entry.metric} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-zinc-300">{entry.metric}</span>
                    <span className="text-zinc-500">{entry.base} → {entry.compare}</span>
                    <span className={entry.direction === 'up' ? 'text-emerald-300' : entry.direction === 'down' ? 'text-red-300' : 'text-zinc-400'}>
                      {entry.changePct > 0 ? '+' : ''}{entry.changePct}%
                    </span>
                    <Badge variant={entry.beyondThreshold ? 'warning' : 'outline'}>
                      {entry.beyondThreshold ? '越过阈值' : '阈值内'}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {derived?.evaluation && (
            <p className="mt-3 text-xs text-zinc-400">
              评测聚合：{derived.evaluation.runs ?? 0} 个 run · avgScore {derived.evaluation.avgScore ?? '—'} · passRate {derived.evaluation.passRate ?? '—'}
              <span className="ml-2 text-[11px] text-zinc-500">（规则 {derived.evaluation.rule ?? 'server-mean'}）</span>
            </p>
          )}
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-zinc-500">完整派生层（原始 JSON，如实呈现）</summary>
            <div className="mt-2"><ValueView value={insight.derived} /></div>
          </details>
        </LayerSection>

        <LayerSection
          layer="interpretation"
          source={layering?.interpretation}
          description="LLM 解读：独立字段与独立写入路径。写入前断言事实层不变 + factsHash 条件更新；事实已变化则拒写（解读必须基于最新事实重写）。"
        >
          {interpretation && Array.isArray(interpretation.items) && interpretation.items.length > 0 ? (
            <>
              <ul className="space-y-1">
                {interpretation.items.map((item, index) => (
                  <li key={index} className="border-l border-amber-900/60 pl-3"><TextBlock>{item}</TextBlock></li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] text-zinc-500">
                来源 <code className="font-mono">{interpretation.source ?? 'llm-interpretation'}</code>
                {interpretation.model ? ` · 模型 ${interpretation.model}` : ' · 未标注模型'}
                {interpretation.attachedAt ? ` · 写入于 ${formatDateTime(interpretation.attachedAt)}` : ''}
              </p>
            </>
          ) : (
            <Hint>尚未写入解读（解读层留空不代表事实层缺失——两层互不冒充）</Hint>
          )}
          <div className="mt-3">
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              {interpretation && interpretation.items?.length ? '重写 LLM 解读' : '写入 LLM 解读'}
            </Button>
          </div>
        </LayerSection>
      </div>

      <section className="mt-8">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-zinc-300">引用该洞察的假设</h2>
          <Hint>口径：后端假设列表端点无 insightId 参数——本页按洞察所属组织拉取最近 100 条后在客户端按 insightId 过滤</Hint>
        </div>
        {hypothesesQuery.isLoading && <SkeletonLines lines={2} />}
        {hypothesesQuery.error && (
          <p className="py-4 text-xs text-red-400">假设列表加载失败：{hypothesesQuery.error.message}</p>
        )}
        {!hypothesesQuery.isLoading && !hypothesesQuery.error && referencing.length === 0 && (
          <EmptyState>暂无假设引用该洞察</EmptyState>
        )}
        <ul className="space-y-2">
          {referencing.map((hypothesis) => (
            <li key={hypothesis.id}>
              <Link
                href={`/creative/hypotheses/${hypothesis.id}`}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 transition hover:border-zinc-700"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{hypothesis.statement}</span>
                <HypothesisStatusCell status={hypothesis.status} />
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-3">
          <Link href={`/creative/hypotheses?insightId=${encodeURIComponent(id)}`} className="text-xs text-zinc-400 hover:text-zinc-100">
            基于该洞察新建假设 →
          </Link>
        </div>
      </section>

      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setFormError(''); }}>
        <DialogHeader>
          <div>
            <DialogTitle>写入 LLM 解读</DialogTitle>
            <DialogDescription>
              解读写入独立于事实层：服务端以 factsHash 条件更新，事实层逐字节不变（被改写即拒写）。
            </DialogDescription>
          </div>
          <DialogCloseButton onClose={() => setOpen(false)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">解读要点（每行一条，1~{ITEM_COUNT_MAX} 条，单条 ≤{ITEM_MAX} 字）</span>
            <Textarea
              aria-label="解读要点"
              rows={5}
              value={itemsText}
              placeholder={'例如：\nCTR 环比上升主要来自素材 A 的更换\nROAS 仍低于目标，需控制预算'}
              onChange={(event) => setItemsText(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">模型标注（可选，≤100 字）</span>
            <Input aria-label="模型标注" value={model} placeholder="如 gpt-4o-mini" onChange={(event) => setModel(event.target.value)} />
          </label>
          <Hint>LLM 只做解读：判定（validated/rejected）由人工/评测给出，LLM 不决定治理判定。</Hint>
          <ActionError message={formError} />
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>取消</Button>
          <Button size="sm" disabled={interpretMutation.isPending} onClick={submitInterpretation}>
            {interpretMutation.isPending ? '写入中…' : '写入解读'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
