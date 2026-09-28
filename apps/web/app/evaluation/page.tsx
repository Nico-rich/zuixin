'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

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

const RUN_STATUS_STYLE: Record<string, string> = {
  pending: 'bg-zinc-800 text-zinc-400',
  running: 'bg-sky-900/60 text-sky-300',
  completed: 'bg-emerald-900/60 text-emerald-300',
  failed: 'bg-red-900/60 text-red-300',
  cancelled: 'bg-amber-900/60 text-amber-300',
};

/**
 * M9-P1 评测（**只读**）：数据集 / 评测运行 / 实验列表。
 * 评测结果的权威展示 = run 详情页（caseRun 事实 + 每评测器分数 + baseline 对照）；
 * 本页绝不提供写操作（写路径在 API 侧受 evaluation.write 守卫，仅 owner/admin）。
 */
export default function EvaluationPage() {
  const [datasets, setDatasets] = useState<DatasetSummary[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      apiFetch<{ data: { datasets: DatasetSummary[] } }>('/api/v1/evaluation/datasets'),
      apiFetch<{ data: { runs: RunSummary[] } }>('/api/v1/evaluation/runs'),
      apiFetch<{ data: { experiments: ExperimentSummary[] } }>('/api/v1/evaluation/experiments'),
    ])
      .then(([d, r, e]) => {
        setDatasets(d.data.datasets);
        setRuns(r.data.runs);
        setExperiments(e.data.experiments);
      })
      .catch(() => setError('评测数据加载失败'));
  }, []);

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (datasets === null) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">评测</h1>
        <span className="text-xs text-zinc-500">版本锁定 · 可复现 · 只读视图</span>
      </div>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium text-zinc-300">数据集</h2>
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
        <h2 className="mb-2 text-sm font-medium text-zinc-300">评测运行</h2>
        {runs.length === 0 && <p className="py-4 text-center text-xs text-zinc-500">暂无运行</p>}
        <ul className="space-y-2">
          {runs.map((r) => (
            <li key={r.id}>
              <Link
                href={`/evaluation/runs/${r.id}`}
                className="flex items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-xs transition hover:border-zinc-700"
              >
                <span className={`shrink-0 rounded px-2 py-0.5 ${RUN_STATUS_STYLE[r.status] ?? RUN_STATUS_STYLE.pending}`}>{r.status}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-zinc-400">{r.id}</span>
                <span className="shrink-0 text-zinc-600">
                  v{r.datasetVersion} · {r.completedCases}/{r.totalCases} case
                  {r.baselineRunId ? ' · 含基线对照' : ''}
                </span>
                <span className="shrink-0 text-zinc-600">{new Date(r.createdAt).toLocaleString()}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-300">实验</h2>
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
    </div>
  );
}
