'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

interface WorkflowRunSummary {
  id: string;
  status: string;
  triggerType: string;
  attempt: number;
  createdAt: string;
  completedAt: string | null;
  version: { version: number };
}

const STATUS_STYLE: Record<string, string> = {
  completed: 'text-emerald-300', failed: 'text-red-400', cancelled: 'text-zinc-400',
  timeout: 'text-amber-300', running: 'text-sky-300', waiting: 'text-violet-300', queued: 'text-zinc-500',
};

/** 最小 Run 列表（M7-P6） */
export default function WorkflowRunsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<{ data: WorkflowRunSummary[] }>(`/api/v1/workflows/${id}/runs?take=50`)
      .then((res) => setRuns(res.data))
      .catch(() => setError('运行列表加载失败'));
  }, [id]);

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (!runs) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-lg font-semibold text-zinc-100">运行历史</h1>
        <Link href={`/workflows/${id}`} className="text-xs text-zinc-500 hover:text-zinc-300">← 返回工作流</Link>
      </div>
      {runs.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">暂无运行</p>}
      <ul className="space-y-2">
        {runs.map((r) => (
          <li key={r.id}>
            <Link href={`/workflows/runs/${r.id}`}
              className="flex items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-sm transition hover:border-zinc-700">
              <span className={`w-16 shrink-0 text-xs ${STATUS_STYLE[r.status] ?? 'text-zinc-400'}`}>{r.status}</span>
              <span className="text-xs text-zinc-500">{r.triggerType} · v{r.version.version} · 第 {r.attempt} 次</span>
              <span className="ml-auto text-xs text-zinc-600">{new Date(r.createdAt).toLocaleString()}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
