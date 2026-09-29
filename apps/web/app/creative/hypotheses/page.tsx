'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SkeletonLines } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { useApiMutation, useApiQuery, useApiQueryClient } from '@/lib/api';
import {
  createHypothesis, creativeKeys, listHypotheses, type HypothesisStatus, type HypothesisView, type SuccessCriteria,
} from '@/lib/services/creative';
import { ActionError, EmptyState, FieldRow, Hint, HypothesisStatusCell, StatusMachine } from '../components/creative-ui';
import {
  asView, criteriaText, formatDateTime, HYPOTHESIS_STATUS_LABEL, HYPOTHESIS_STATUS_ORDER, shortId,
  type LoopRefShape, type VerdictShape,
} from '../components/creative-view';

/**
 * M13-W4 假设列表（/creative/hypotheses）
 *
 * - 状态 Badge（draft/ready/running/validated/rejected）+ 状态机展示（可达边来自后端规则镜像）；
 * - 新建假设（Dialog）：statement / rationale / target / platform（+ 可选来源洞察与成功判据）；
 * - 状态机裁决一律在服务端（`hypothesis-status.ts` + status/version CAS）；本页只做展示与入参校验。
 */

const STATEMENT_MIN = 4;
const STATEMENT_MAX = 300;
const CRITERIA_METRICS: ReadonlyArray<SuccessCriteria['metric']> = ['avg_score', 'pass_rate', 'roas', 'ctr'];

export default function HypothesesPage() {
  const queryClient = useApiQueryClient();
  const { toast } = useToast();
  const [status, setStatus] = useState<HypothesisStatus | ''>('');
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState('');
  const [rationale, setRationale] = useState('');
  const [target, setTarget] = useState('');
  const [platform, setPlatform] = useState('');
  const [insightId, setInsightId] = useState('');
  const [useCriteria, setUseCriteria] = useState(false);
  const [criteriaMetric, setCriteriaMetric] = useState<SuccessCriteria['metric']>('avg_score');
  const [criteriaOp, setCriteriaOp] = useState<SuccessCriteria['op']>('gte');
  const [criteriaValue, setCriteriaValue] = useState('0.8');
  const [formError, setFormError] = useState('');

  // 来自洞察详情页的「基于该洞察新建假设」入口：?insightId=… 预填并直接打开 Dialog
  // （刻意不用 useSearchParams：避免静态预渲染对 Suspense 边界的额外要求）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const fromInsight = new URLSearchParams(window.location.search).get('insightId');
    if (fromInsight) {
      setInsightId(fromInsight);
      setOpen(true);
    }
  }, []);

  const hypothesesQuery = useApiQuery<{ data: { hypotheses: HypothesisView[] } }>({
    queryKey: creativeKeys.hypotheses({ status: status || undefined, limit: 50 }),
    path: `/api/v1/creative-loop/hypotheses?limit=50${status ? `&status=${status}` : ''}`,
  });

  const createMutation = useApiMutation(
    (input: Parameters<typeof createHypothesis>[0]) => createHypothesis(input),
    {
      onSuccess: () => {
        setOpen(false);
        setFormError('');
        setStatement('');
        setRationale('');
        setTarget('');
        setPlatform('');
        setUseCriteria(false);
        toast({ title: '假设已创建', description: '初始状态 draft；提交就绪后方可启动 loop', variant: 'success' });
        void queryClient.invalidateQueries({ queryKey: ['creative-hypotheses'] });
      },
      onError: (error) => setFormError(error.message),
    },
  );

  const submit = () => {
    const text = statement.trim();
    if (text.length < STATEMENT_MIN || text.length > STATEMENT_MAX) {
      setFormError(`假设陈述需 ${STATEMENT_MIN}~${STATEMENT_MAX} 字`);
      return;
    }
    let successCriteria: SuccessCriteria | undefined;
    if (useCriteria) {
      const parsed = Number(criteriaValue);
      if (!Number.isFinite(parsed)) {
        setFormError('成功判据的阈值必须是数字');
        return;
      }
      successCriteria = { metric: criteriaMetric, op: criteriaOp, value: parsed };
    }
    setFormError('');
    createMutation.mutate({
      statement: text,
      ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
      ...(target.trim() ? { target: target.trim() } : {}),
      ...(platform.trim() ? { platform: platform.trim() } : {}),
      ...(insightId.trim() ? { insightId: insightId.trim() } : {}),
      ...(successCriteria ? { successCriteria } : {}),
    });
  };

  const hypotheses = hypothesesQuery.data?.data.hypotheses ?? [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/creative" className="text-xs text-zinc-500 hover:text-zinc-300">← 创意工作台</Link>

      <div className="mt-4 mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">创意假设</h1>
          <p className="mt-1 text-xs text-zinc-500">
            假设只引用洞察（绝不改写洞察事实）；loop 启动后假设锁定，判定由人工/判据给出——LLM 不决定治理判定。
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>新建假设</Button>
      </div>

      <div className="mb-4 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
        <div className="mb-2 text-xs text-zinc-500">状态机（裁决在服务端：status CAS + version CAS，非法边一律 400）</div>
        <StatusMachine />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          状态筛选
          <Select
            aria-label="状态筛选"
            className="h-8 w-40"
            value={status}
            onChange={(event) => setStatus(event.target.value as HypothesisStatus | '')}
          >
            <option value="">全部状态</option>
            {HYPOTHESIS_STATUS_ORDER.map((value) => (
              <option key={value} value={value}>{HYPOTHESIS_STATUS_LABEL[value]}（{value}）</option>
            ))}
          </Select>
        </label>
        <span className="text-xs text-zinc-600">共 {hypotheses.length} 条</span>
      </div>

      {hypothesesQuery.isLoading && <SkeletonLines lines={3} />}
      {hypothesesQuery.error && (
        <p className="py-8 text-sm text-red-400">假设列表加载失败：{hypothesesQuery.error.message}</p>
      )}
      {!hypothesesQuery.isLoading && !hypothesesQuery.error && hypotheses.length === 0 && (
        <EmptyState>暂无假设——用「新建假设」起草第一条（draft → 提交就绪 → 启动 loop）</EmptyState>
      )}

      <ul className="space-y-2">
        {hypotheses.map((hypothesis) => {
          const loop = asView<LoopRefShape | null>(hypothesis.loop);
          const verdict = asView<VerdictShape | null>(hypothesis.verdict);
          const criteria = criteriaText(hypothesis.successCriteria);
          return (
            <li key={hypothesis.id}>
              <Link
                href={`/creative/hypotheses/${hypothesis.id}`}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 transition hover:border-zinc-700"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-200">{hypothesis.statement}</span>
                  <span className="block truncate text-xs text-zinc-500">
                    {criteria ? `判据 ${criteria}` : '未声明判据'}
                    {hypothesis.target ? ` · 目标 ${hypothesis.target}` : ''}
                    {hypothesis.platform ? ` · 平台 ${hypothesis.platform}` : ''}
                    {loop?.runId ? ` · run ${shortId(loop.runId)}` : ''}
                    {verdict?.decidedBy ? ` · 判定者 ${verdict.decidedBy}` : ''}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] text-zinc-600">{formatDateTime(hypothesis.updatedAt)}</span>
                <HypothesisStatusCell status={hypothesis.status} />
              </Link>
            </li>
          );
        })}
      </ul>

      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setFormError(''); }}>
        <DialogHeader>
          <div>
            <DialogTitle>新建假设</DialogTitle>
            <DialogDescription>
              创建即 draft（草稿）。提交就绪（ready）后才能启动 loop；loop 启动后陈述锁定，不可再编辑。
            </DialogDescription>
          </div>
          <DialogCloseButton onClose={() => setOpen(false)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">假设陈述（{STATEMENT_MIN}~{STATEMENT_MAX} 字）</span>
            <Textarea
              aria-label="假设陈述"
              rows={3}
              value={statement}
              placeholder="例如：将素材主视觉换成高对比配色后，CTR 会在两周内提升 15%"
              onChange={(event) => setStatement(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">rationale（可选，依据/推理）</span>
            <Textarea aria-label="rationale" rows={2} value={rationale} onChange={(event) => setRationale(event.target.value)} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">target（可选，目标受众）</span>
              <Input aria-label="target" value={target} onChange={(event) => setTarget(event.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">platform（可选）</span>
              <Input aria-label="platform" value={platform} onChange={(event) => setPlatform(event.target.value)} />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">来源洞察 ID（可选，仅引用同组织洞察）</span>
            <Input aria-label="来源洞察 ID" value={insightId} onChange={(event) => setInsightId(event.target.value)} />
          </label>
          <div className="rounded-lg border border-zinc-800/80 p-3">
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" checked={useCriteria} onChange={(event) => setUseCriteria(event.target.checked)} />
              声明成功判据（loop 跑完后服务端按判据自动收敛；不声明则判定必须显式给出）
            </label>
            {useCriteria && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Select
                  aria-label="判据指标"
                  className="h-8 w-36"
                  value={criteriaMetric}
                  onChange={(event) => setCriteriaMetric(event.target.value as SuccessCriteria['metric'])}
                >
                  {CRITERIA_METRICS.map((metric) => <option key={metric} value={metric}>{metric}</option>)}
                </Select>
                <Select
                  aria-label="判据比较"
                  className="h-8 w-24"
                  value={criteriaOp}
                  onChange={(event) => setCriteriaOp(event.target.value as SuccessCriteria['op'])}
                >
                  <option value="gte">≥</option>
                  <option value="lte">≤</option>
                </Select>
                <Input
                  aria-label="判据阈值"
                  className="h-8 w-28"
                  value={criteriaValue}
                  onChange={(event) => setCriteriaValue(event.target.value)}
                />
              </div>
            )}
          </div>
          <ActionError message={formError} />
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>取消</Button>
          <Button size="sm" disabled={createMutation.isPending} onClick={submit}>
            {createMutation.isPending ? '创建中…' : '创建假设'}
          </Button>
        </DialogFooter>
      </Dialog>

      <div className="mt-6">
        <FieldRow label="口径">
          <Hint>列表默认取最近 50 条；状态筛选走服务端 status 参数（不是客户端过滤）</Hint>
        </FieldRow>
      </div>
    </div>
  );
}
