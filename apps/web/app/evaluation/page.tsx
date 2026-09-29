'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { apiFetch, jsonInit, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { WriteError, toApiError } from '@/components/write-error';
import { useToast } from '@/components/ui/toast';

interface DatasetSummary {
  id: string;
  name: string;
  description: string | null;
  version: number;
  caseCount: number;
  runCount: number;
  updatedAt: string;
}

interface RunSummary {
  id: string;
  datasetId: string;
  datasetVersion: number;
  agentVersionId: string;
  status: string;
  totalCases: number;
  completedCases: number;
  baselineRunId: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface ExperimentSummary {
  id: string;
  name: string;
  status: string;
  variantCount: number;
  createdAt: string;
}

interface EvaluatorSummary {
  id: string;
  name: string;
  type: string;
}

const RUN_STATUS_STYLE: Record<string, string> = {
  pending: 'bg-zinc-800 text-zinc-400',
  running: 'bg-sky-900/60 text-sky-300',
  completed: 'bg-emerald-900/60 text-emerald-300',
  failed: 'bg-red-900/60 text-red-300',
  cancelled: 'bg-amber-900/60 text-amber-300',
};

/** 与服务端 evaluation-runs.service.ts 的 ACTIVE_STATUSES 逐字对齐（cancel 只对 pending/running 生效） */
const RUN_ACTIVE = ['pending', 'running'];

const WRITE_HINT = '需要组织 owner/admin 权限（evaluation.write）';

/**
 * 评测（M9-P1 读面 + M13-W10 写面最小集）：数据集 / 评测运行 / 实验。
 *
 * 写面只做**最小可见闭环**（能建数据集与用例、能发起/取消评测运行、能建实验）：
 *  - 评测结果的事实呈现仍在 run 详情页（caseRun 事实 + 逐评测器分数 + baseline 对照）；
 *  - 权限**不隐藏入口**：写路径服务端裁决（evaluation.write 仅 owner/admin），403 一律渲染成权限徽标，
 *    前端绝不预判、绝不静默吞掉（见 WriteError 口径）；
 *  - 归属与身份（organizationId/userId/agentId）全部服务端解析，前端只提交 id。
 */
export default function EvaluationPage() {
  const { toast } = useToast();
  const [datasets, setDatasets] = useState<DatasetSummary[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [error, setError] = useState('');
  /** 写失败按操作各自持有：同一份状态在多处渲染 = 同一错误在一屏出现两次、还会串到别的弹窗 */
  const [dsError, setDsError] = useState<ApiError | null>(null);
  const [runError, setRunError] = useState<ApiError | null>(null);
  const [expError, setExpError] = useState<ApiError | null>(null);
  const [cancelError, setCancelError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  // 新建数据集
  const [datasetOpen, setDatasetOpen] = useState(false);
  const [dsName, setDsName] = useState('');
  const [dsDescription, setDsDescription] = useState('');
  // 新建评测运行
  const [runOpen, setRunOpen] = useState(false);
  const [runDatasetId, setRunDatasetId] = useState('');
  const [agentVersionId, setAgentVersionId] = useState('');
  const [baselineRunId, setBaselineRunId] = useState('');
  const [evaluatorIds, setEvaluatorIds] = useState<string[]>([]);
  const [evaluators, setEvaluators] = useState<EvaluatorSummary[] | null>(null);
  const [evaluatorsError, setEvaluatorsError] = useState('');
  // 新建实验
  const [expOpen, setExpOpen] = useState(false);
  const [expName, setExpName] = useState('');
  const [expHypothesis, setExpHypothesis] = useState('');
  const [localError, setLocalError] = useState('');
  // 取消运行
  const [cancelling, setCancelling] = useState<RunSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, r, e] = await Promise.all([
        apiFetch<{ data: { datasets: DatasetSummary[] } }>('/api/v1/evaluation/datasets'),
        apiFetch<{ data: { runs: RunSummary[] } }>('/api/v1/evaluation/runs'),
        apiFetch<{ data: { experiments: ExperimentSummary[] } }>('/api/v1/evaluation/experiments'),
      ]);
      setDatasets(d.data.datasets);
      setRuns(r.data.runs);
      setExperiments(e.data.experiments);
      setError('');
    } catch {
      setError('评测数据加载失败');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openDataset = () => { setDsName(''); setDsDescription(''); setLocalError(''); setDsError(null); setDatasetOpen(true); };
  const openExperiment = () => { setExpName(''); setExpHypothesis(''); setLocalError(''); setExpError(null); setExpOpen(true); };

  const openRun = async () => {
    setRunDatasetId(datasets?.[0]?.id ?? '');
    setAgentVersionId(''); setBaselineRunId(''); setEvaluatorIds([]);
    setLocalError(''); setRunError(null); setEvaluatorsError('');
    setRunOpen(true);
    if (evaluators === null) {
      // 评测器列表懒加载：只为「选择评测器」这一步付请求成本（列表页首屏保持 3 个只读请求）
      try {
        const res = await apiFetch<{ data: { evaluators: EvaluatorSummary[] } }>('/api/v1/evaluation/evaluators');
        setEvaluators(res.data.evaluators);
      } catch {
        setEvaluatorsError('评测器列表加载失败：本次可不选评测器（运行仍会产出输出与成本事实，但不会打分）');
        setEvaluators([]);
      }
    }
  };

  const createDataset = async () => {
    const name = dsName.trim();
    if (!name || pending) return;
    setLocalError(''); setDsError(null); setPending(true);
    try {
      const res = await apiFetch<{ data: DatasetSummary }>('/api/v1/evaluation/datasets', jsonInit('POST', {
        name,
        ...(dsDescription.trim() ? { description: dsDescription.trim() } : {}),
      }));
      setDatasetOpen(false);
      toast({ title: '数据集已创建', description: `${res.data.name}（v1，暂无用例）`, variant: 'success' });
      await load();
    } catch (err) {
      setDsError(toApiError(err, '创建失败，请重试'));
    } finally { setPending(false); }
  };

  const createRun = async () => {
    if (!runDatasetId || !agentVersionId.trim() || pending) return;
    setLocalError(''); setRunError(null); setPending(true);
    try {
      const res = await apiFetch<{ data: RunSummary }>('/api/v1/evaluation/runs', jsonInit('POST', {
        datasetId: runDatasetId,
        agentVersionId: agentVersionId.trim(),
        ...(evaluatorIds.length ? { evaluatorIds } : {}),
        ...(baselineRunId ? { baselineRunId } : {}),
      }));
      setRunOpen(false);
      toast({ title: '评测运行已创建', description: `${res.data.id}（锁定 v${res.data.datasetVersion} 数据集）`, variant: 'success' });
      await load();
    } catch (err) {
      setRunError(toApiError(err, '创建失败，请重试'));
    } finally { setPending(false); }
  };

  const createExperiment = async () => {
    const name = expName.trim();
    if (!name || pending) return;
    let hypothesis: Record<string, unknown> | undefined;
    if (expHypothesis.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(expHypothesis);
      } catch {
        setLocalError('hypothesis 必须是合法 JSON');
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        // 服务端 z.record(z.unknown())：数组/标量一律拒绝 → 本地先如实拦截，不发请求
        setLocalError('hypothesis 必须是 JSON 对象（如 {"期待":"上下文跟随"}）');
        return;
      }
      hypothesis = parsed as Record<string, unknown>;
    }
    setLocalError(''); setExpError(null); setPending(true);
    try {
      const res = await apiFetch<{ data: ExperimentSummary }>('/api/v1/evaluation/experiments', jsonInit('POST', {
        name,
        ...(hypothesis ? { hypothesis } : {}),
      }));
      setExpOpen(false);
      toast({ title: '实验已创建', description: `${res.data.name}（draft；实验只做评测对照，绝不下发线上流量）`, variant: 'success' });
      await load();
    } catch (err) {
      setExpError(toApiError(err, '创建失败，请重试'));
    } finally { setPending(false); }
  };

  const confirmCancel = async () => {
    if (!cancelling) return;
    setCancelError(null); setPending(true);
    try {
      await apiFetch(`/api/v1/evaluation/runs/${cancelling.id}/cancel`, { method: 'POST' });
      setCancelling(null);
      toast({ title: '评测运行已取消', variant: 'success' });
      await load();
    } catch (err) {
      setCancelError(toApiError(err, '取消失败，请重试'));
    } finally { setPending(false); }
  };

  const toggleEvaluator = (id: string) => {
    setEvaluatorIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (datasets === null) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  const knownAgentVersions = Array.from(new Set(runs.map((r) => r.agentVersionId)));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">评测</h1>
        <span className="text-xs text-zinc-500">版本锁定 · 可复现 · 写路径受 evaluation.write 守卫</span>
      </div>

      <section className="mb-8">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-zinc-300">数据集</h2>
          <Button size="sm" variant="outline" onClick={openDataset}><Plus /> 新建数据集</Button>
        </div>
        {datasets.length === 0 && <p className="py-4 text-center text-xs text-zinc-500">暂无数据集</p>}
        <ul className="space-y-2">
          {datasets.map((d) => (
            <li key={d.id}>
              <Link
                href={`/evaluation/datasets/${d.id}`}
                className="flex items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-sm transition hover:border-zinc-700"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-zinc-200">{d.name}</span>
                  {d.description && <span className="block truncate text-xs text-zinc-500">{d.description}</span>}
                </span>
                <span className="shrink-0 text-xs text-zinc-600">v{d.version} · {d.caseCount} 用例 · {d.runCount} 次评测</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-8">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-zinc-300">评测运行</h2>
          <Button size="sm" variant="outline" onClick={() => void openRun()}><Plus /> 新建评测运行</Button>
        </div>
        {runs.length === 0 && <p className="py-4 text-center text-xs text-zinc-500">暂无运行</p>}
        <ul className="space-y-2">
          {runs.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <Link
                href={`/evaluation/runs/${r.id}`}
                className="flex flex-1 items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-xs transition hover:border-zinc-700"
              >
                <span className={`shrink-0 rounded px-2 py-0.5 ${RUN_STATUS_STYLE[r.status] ?? RUN_STATUS_STYLE.pending}`}>{r.status}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-zinc-400">{r.id}</span>
                <span className="shrink-0 text-zinc-600">
                  v{r.datasetVersion} · {r.completedCases}/{r.totalCases} case
                  {r.baselineRunId ? ' · 含基线对照' : ''}
                </span>
                <span className="shrink-0 text-zinc-600">{new Date(r.createdAt).toLocaleString()}</span>
              </Link>
              {RUN_ACTIVE.includes(r.status) && (
                <button
                  onClick={() => { setCancelError(null); setCancelling(r); }}
                  disabled={pending}
                  className="shrink-0 rounded border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 transition hover:border-red-800/60 hover:text-red-300 disabled:opacity-40"
                  title="终止这个尚未结束的评测运行"
                >
                  取消
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-zinc-300">实验</h2>
          <Button size="sm" variant="outline" onClick={openExperiment}><Plus /> 新建实验</Button>
        </div>
        <p className="mb-2 text-xs text-zinc-600">实验/变体只做评测对照，绝不下发线上流量（与 Provider Routing 严格分离）</p>
        {experiments.length === 0 && <p className="py-4 text-center text-xs text-zinc-500">暂无实验</p>}
        <ul className="space-y-2">
          {experiments.map((e) => (
            <li key={e.id} className="flex items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-xs">
              <span className="min-w-0 flex-1 truncate text-zinc-200">{e.name}</span>
              <span className="shrink-0 text-zinc-600">{e.variantCount} 个变体</span>
              <span className="shrink-0 rounded bg-zinc-800 px-2 py-0.5 text-zinc-400">{e.status}</span>
            </li>
          ))}
        </ul>
      </section>

      <Dialog open={datasetOpen} onOpenChange={(open) => { if (!open) { setDatasetOpen(false); setDsError(null); } }}>
        <form onSubmit={(e) => { e.preventDefault(); void createDataset(); }}>
          <DialogHeader>
            <div className="min-w-0">
              <DialogTitle>新建数据集</DialogTitle>
              <DialogDescription>创建 v1 空数据集；用例在数据集详情页写入（整批替换 → 版本 +1）。</DialogDescription>
            </div>
          </DialogHeader>
          <DialogContent className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="ds-name" className="block text-xs text-zinc-400">名称</label>
              <Input id="ds-name" value={dsName} maxLength={120} autoFocus placeholder="例如：回归用例集"
                onChange={(e) => setDsName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="ds-desc" className="block text-xs text-zinc-400">描述（可选）</label>
              <Input id="ds-desc" value={dsDescription} maxLength={2000} onChange={(e) => setDsDescription(e.target.value)} />
            </div>
            {localError && <p className="text-xs text-zinc-400">{localError}</p>}
            <WriteError error={dsError} forbiddenHint={WRITE_HINT} />
          </DialogContent>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDatasetOpen(false)} disabled={pending}>取消</Button>
            <Button type="submit" disabled={pending || !dsName.trim()}>{pending ? '创建中…' : '创建'}</Button>
          </DialogFooter>
        </form>
      </Dialog>

      <Dialog open={runOpen} onOpenChange={(open) => { if (!open) { setRunOpen(false); setRunError(null); } }}>
        <form onSubmit={(e) => { e.preventDefault(); void createRun(); }}>
          <DialogHeader>
            <div className="min-w-0">
              <DialogTitle>新建评测运行</DialogTitle>
              <DialogDescription>
                锁定「数据集当前版本 + AgentVersion 快照」执行；重复评测同一版本会得到可复现的同一事实集合。
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogContent className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="run-dataset" className="block text-xs text-zinc-400">数据集</label>
              <select id="run-dataset" value={runDatasetId} onChange={(e) => setRunDatasetId(e.target.value)}
                className="h-9 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200">
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}（v{d.version} · {d.caseCount} 用例）</option>
                ))}
              </select>
              {datasets.some((d) => d.id === runDatasetId && d.caseCount === 0) && (
                <p className="text-xs text-zinc-500">该数据集当前版本没有用例 → 服务端会拒绝创建（400）。请先在数据集页写入用例。</p>
              )}
            </div>
            <div className="space-y-1">
              <label htmlFor="run-agent-version" className="block text-xs text-zinc-400">Agent 版本 ID（AgentVersion 不可变）</label>
              <Input id="run-agent-version" value={agentVersionId} list="known-agent-versions" maxLength={100}
                placeholder="av-xxxx（历史运行出现过的版本会给出建议）" onChange={(e) => setAgentVersionId(e.target.value)} />
              <datalist id="known-agent-versions">
                {knownAgentVersions.map((v) => <option key={v} value={v} />)}
              </datalist>
              <p className="text-xs text-zinc-500">agentId 由服务端从该版本行解析（前端不提交身份声明）。</p>
            </div>
            <div className="space-y-1">
              <label htmlFor="run-baseline" className="block text-xs text-zinc-400">基线运行（可选，用于对照）</label>
              <select id="run-baseline" value={baselineRunId} onChange={(e) => setBaselineRunId(e.target.value)}
                className="h-9 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200">
                <option value="">不设基线</option>
                {runs.map((r) => <option key={r.id} value={r.id}>{r.id}（{r.status}）</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <span className="block text-xs text-zinc-400">评测器（可多选）</span>
              {evaluators === null && <p className="text-xs text-zinc-500">评测器加载中…</p>}
              {evaluatorsError && <p className="text-xs text-zinc-400">{evaluatorsError}</p>}
              {evaluators && evaluators.length === 0 && !evaluatorsError && (
                <p className="text-xs text-zinc-500">组织内还没有评测器 → 本次运行只产出输出与成本事实，不打分。</p>
              )}
              <div className="space-y-1">
                {(evaluators ?? []).map((ev) => (
                  <label key={ev.id} className="flex items-center gap-2 text-xs text-zinc-300">
                    <input type="checkbox" checked={evaluatorIds.includes(ev.id)} onChange={() => toggleEvaluator(ev.id)} />
                    <span>{ev.name}</span>
                    <span className="font-mono text-zinc-500">{ev.type}</span>
                  </label>
                ))}
              </div>
            </div>
            {localError && <p className="text-xs text-zinc-400">{localError}</p>}
            <WriteError error={runError} forbiddenHint={WRITE_HINT} />
          </DialogContent>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRunOpen(false)} disabled={pending}>取消</Button>
            <Button type="submit" disabled={pending || !runDatasetId || !agentVersionId.trim()}>{pending ? '创建中…' : '创建'}</Button>
          </DialogFooter>
        </form>
      </Dialog>

      <Dialog open={expOpen} onOpenChange={(open) => { if (!open) { setExpOpen(false); setExpError(null); } }}>
        <form onSubmit={(e) => { e.preventDefault(); void createExperiment(); }}>
          <DialogHeader>
            <div className="min-w-0">
              <DialogTitle>新建实验</DialogTitle>
              <DialogDescription>创建 draft 实验（变体与状态流转在后续步骤；实验绝不参与线上流量分配）。</DialogDescription>
            </div>
          </DialogHeader>
          <DialogContent className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="exp-name" className="block text-xs text-zinc-400">名称</label>
              <Input id="exp-name" value={expName} maxLength={120} autoFocus placeholder="例如：上下文跟随实验"
                onChange={(e) => setExpName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="exp-hypothesis" className="block text-xs text-zinc-400">假设（JSON 对象，可选）</label>
              <Textarea id="exp-hypothesis" value={expHypothesis} rows={4} spellCheck={false} className="font-mono text-xs"
                placeholder={'{"假设":"精简 system prompt 不降低通过率"}'} onChange={(e) => setExpHypothesis(e.target.value)} />
            </div>
            {localError && <p className="text-xs text-zinc-400">{localError}</p>}
            <WriteError error={expError} forbiddenHint={WRITE_HINT} />
          </DialogContent>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setExpOpen(false)} disabled={pending}>取消</Button>
            <Button type="submit" disabled={pending || !expName.trim()}>{pending ? '创建中…' : '创建'}</Button>
          </DialogFooter>
        </form>
      </Dialog>

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => { if (!open) { setCancelling(null); setCancelError(null); } }}
        title="取消评测运行"
        description={`将终止评测运行 ${cancelling?.id ?? ''}（状态改为 cancelled，未跑的用例不再执行）。已产出的 caseRun 事实保留。`}
        confirmLabel="取消运行"
        cancelLabel="返回"
        destructive
        pending={pending}
        error={cancelError}
        forbiddenHint={WRITE_HINT}
        onConfirm={() => void confirmCancel()}
      />
    </div>
  );
}
