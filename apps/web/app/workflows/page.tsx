'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'published' | 'archived';
  updatedAt: string;
  versions: Array<{ version: number; status: string }>;
  _count: { runs: number };
}

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-zinc-800 text-zinc-400', published: 'bg-emerald-900/60 text-emerald-300', archived: 'bg-zinc-800 text-zinc-500',
};

/** 最小 Workflow 列表（M7-P6；不做 React Flow IDE） */
export default function WorkflowsPage() {
  const [items, setItems] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<{ data: WorkflowSummary[] }>('/api/v1/workflows')
      .then((res) => setItems(res.data))
      .catch(() => setError('工作流列表加载失败'));
  }, []);

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (items === null) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">工作流</h1>
        <span className="text-xs text-zinc-500">确定性编排 · 版本锁定执行</span>
      </div>
      {items.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">暂无工作流</p>}
      <ul className="space-y-2">
        {items.map((w) => (
          <li key={w.id}>
            <Link
              href={`/workflows/${w.id}`}
              className="flex items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-sm transition hover:border-zinc-700"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-zinc-200">{w.name}</span>
                {w.description && <span className="block truncate text-xs text-zinc-500">{w.description}</span>}
              </span>
              <span className="text-xs text-zinc-600">v{w.versions[0]?.version ?? 1} · {w._count.runs} 次运行</span>
              <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[w.status] ?? STATUS_STYLE.draft}`}>{w.status}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
