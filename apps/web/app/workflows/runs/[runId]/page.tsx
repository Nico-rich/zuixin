'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

interface WorkflowTimeline {
  runId: string;
  workflowId: string;
  version: number;
  status: string;
  triggerType: string;
  startedAt: string;
  completedAt: string | null;
  items: Array<{ id: string; type: string; status: string; timestamp: string; title: string; summary?: string }>;
}

const ICONS: Record<string, string> = {
  'workflow.started': '▶', 'workflow.completed': '✅', 'workflow.failed': '❌', 'workflow.cancelled': '⏹', 'workflow.timeout': '⏰',
  'step.completed': '▸', 'step.failed': '❌', 'step.waiting': '⏳', 'step.skipped': '⏭', 'step.queued': '·',
};

/** 最小 Run Timeline（后端投影直渲；不做 IDE/Canvas） */
export default function WorkflowRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const [data, setData] = useState<WorkflowTimeline | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<{ data: WorkflowTimeline }>(`/api/v1/workflows/runs/${runId}/timeline`)
      .then((res) => setData(res.data))
      .catch(() => setError('时间线加载失败'));
  }, [runId]);

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (!data) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-lg font-semibold text-zinc-100">运行时间线</h1>
        <span className="text-xs text-zinc-500">{data.status} · {data.triggerType} · v{data.version}</span>
        <Link href={`/workflows/${data.workflowId}/runs`} className="ml-auto text-xs text-zinc-500 hover:text-zinc-300">← 运行历史</Link>
      </div>
      <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3">
        {data.items.map((item) => (
          <div key={item.id} className="flex items-start gap-2 py-1 text-xs">
            <span className="mt-0.5 w-4 shrink-0 text-center">{ICONS[item.type] ?? '•'}</span>
            <span className={`min-w-0 flex-1 ${item.status === 'failed' ? 'text-red-400' : 'text-zinc-300'}`}>{item.title}</span>
            {item.summary && <span className="ml-2 text-zinc-500">{item.summary}</span>}
            <span className="shrink-0 text-zinc-600">{new Date(item.timestamp).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
