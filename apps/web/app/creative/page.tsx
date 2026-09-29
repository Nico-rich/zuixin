'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SkeletonLines } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useApiMutation, useApiQuery, useApiQueryClient } from '@/lib/api';
import { buildInsight, creativeKeys, listInsights, type InsightView } from '@/lib/services/creative';
import { ActionError, Hint, LayerBadge } from './components/creative-ui';
import {
  asView, perfFactPairs, ratingFactPairs, windowLabel, type InsightFactsShape, type InsightInterpretationShape,
} from './components/creative-view';

/**
 * M13-W4 创意工作台总览（/creative）
 *
 * 消费后端 creative-loop 的**洞察面**（list/build）：
 *  - 列表：窗口 + 事实摘要 + **分层标注**（事实 / 派生 / LLM 解读三层如实标注——解读未写入时明说"无解读"，
 *    绝不用空对象冒充"已解读"）；
 *  - 构建：Dialog（时间窗口 / 筛选条件）→ `buildInsight` 生成一份**新快照**（含服务端计算的 factsHash 指纹）。
 *
 * 分层红线（M13 §4）：facts / derived 一律服务端计算，页面只展示、绝不改写；
 * interpretation 是 LLM 层，写入走独立端点（见洞察详情页），页面绝不把解读渲染成事实。
 */

const DEFAULT_DAYS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 事实摘要：只拼接 facts 中**真实存在**的字段（缺失即不展示，绝不补零/臆造） */
function factsSummary(insight: InsightView): string {
  const facts = asView<InsightFactsShape>(insight.facts);
  const parts = perfFactPairs(facts).map(([label, value]) => `${label} ${value}`);
  parts.push(...ratingFactPairs(facts).map(([label, value]) => `${label} ${value}`));
  const runs = facts.evaluation?.runs?.length;
  if (typeof runs === 'number') parts.push(`评测 run ${runs}`);
  return parts.length > 0 ? parts.join(' · ') : '该窗口无聚合事实';
}

function hasInterpretation(insight: InsightView): boolean {
  const interpretation = asView<InsightInterpretationShape | null>(insight.interpretation);
  return Boolean(interpretation && Array.isArray(interpretation.items) && interpretation.items.length > 0);
}

export default function CreativeWorkspacePage() {
  const queryClient = useApiQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(String(DEFAULT_DAYS));
  const [includeEvaluation, setIncludeEvaluation] = useState(true);
  const [artifactId, setArtifactId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [formError, setFormError] = useState('');

  const insightsQuery = useApiQuery<{ data: { insights: InsightView[] } }>({
    queryKey: creativeKeys.insights({ limit: 50 }),
    path: '/api/v1/creative-loop/insights?limit=50',
  });

  const buildMutation = useApiMutation(
    (input: { days: number; includeEvaluation: boolean; artifactId?: string; campaignId?: string }) => buildInsight(input),
    {
      onSuccess: () => {
        setOpen(false);
        setFormError('');
        toast({ title: '洞察已构建', description: '快照含服务端事实层与派生层，解读需另行写入', variant: 'success' });
        // 失效全部洞察列表查询（页面 queryKey 含参数，按前缀失效）
        void queryClient.invalidateQueries({ queryKey: ['creative-insights'] });
      },
      onError: (error) => setFormError(error.message),
    },
  );

  const submit = () => {
    const parsed = Number(days);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
      setFormError('时间窗口必须是 1~365 之间的整数天');
      return;
    }
    if (artifactId.trim() && !UUID_RE.test(artifactId.trim())) {
      setFormError('创意 ID（artifactId）必须是 UUID');
      return;
    }
    if (campaignId.trim() && !UUID_RE.test(campaignId.trim())) {
      setFormError('广告 ID（campaignId）必须是 UUID');
      return;
    }
    setFormError('');
    // strictObject：仅提交非空字段（空串会被后端拒绝）
    buildMutation.mutate({
      days: parsed,
      includeEvaluation,
      ...(artifactId.trim() ? { artifactId: artifactId.trim() } : {}),
      ...(campaignId.trim() ? { campaignId: campaignId.trim() } : {}),
    });
  };

  const insights = insightsQuery.data?.data.insights ?? [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">创意工作台</h1>
          <p className="mt-1 text-xs text-zinc-500">
            闭环：洞察（事实 / 派生 / 解读三层隔离）→ 假设（状态机 draft→ready→running→validated|rejected）→ loop → 判定
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>构建新洞察</Button>
          <Link href="/creative/hypotheses" className="text-xs text-zinc-400 hover:text-zinc-100">假设列表 →</Link>
        </div>
      </div>

      <section className="mb-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-zinc-300">洞察</h2>
          <Hint>洞察是快照：每次构建生成一份新行（factsHash 为事实层指纹，解读写入锚定该指纹）</Hint>
        </div>

        {insightsQuery.isLoading && <SkeletonLines lines={3} />}
        {insightsQuery.error && (
          <p className="py-8 text-sm text-red-400">洞察列表加载失败：{insightsQuery.error.message}</p>
        )}
        {!insightsQuery.isLoading && !insightsQuery.error && insights.length === 0 && (
          <p className="py-8 text-center text-sm text-zinc-500">暂无洞察——用「构建新洞察」生成第一份快照</p>
        )}

        <ul className="space-y-2">
          {insights.map((insight) => (
            <li key={insight.id}>
              <Link
                href={`/creative/insights/${insight.id}`}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 transition hover:border-zinc-700"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-200">{windowLabel(insight.window)}</span>
                  <span className="block truncate text-xs text-zinc-500">{factsSummary(insight)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <LayerBadge layer="facts" />
                  <LayerBadge layer="derived" />
                  {hasInterpretation(insight)
                    ? <LayerBadge layer="interpretation" />
                    : <Badge variant="outline">无解读</Badge>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setFormError(''); }}>
        <DialogHeader>
          <div>
            <DialogTitle>构建新洞察</DialogTitle>
            <DialogDescription>
              服务端按窗口聚合回流事实（绩效 / 评分 / 评测），事实层与派生层一律服务端计算；解读需在详情页另行写入。
            </DialogDescription>
          </div>
          <DialogCloseButton onClose={() => setOpen(false)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">时间窗口（天，1~365）</span>
            <Input
              aria-label="时间窗口（天）"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={includeEvaluation}
              onChange={(event) => setIncludeEvaluation(event.target.checked)}
            />
            聚合评测事实（评测 run 摘要；评测与流量选路严格分离）
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">限定创意 ID（artifactId，可选，UUID）</span>
            <Input
              aria-label="创意 ID"
              value={artifactId}
              placeholder="留空 = 项目/用户全量"
              onChange={(event) => setArtifactId(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">限定广告 ID（campaignId，可选，UUID）</span>
            <Input
              aria-label="广告 ID"
              value={campaignId}
              placeholder="留空 = 项目/用户全量"
              onChange={(event) => setCampaignId(event.target.value)}
            />
          </label>
          <ActionError message={formError} />
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>取消</Button>
          <Button size="sm" disabled={buildMutation.isPending} onClick={submit}>
            {buildMutation.isPending ? '构建中…' : '构建洞察'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
