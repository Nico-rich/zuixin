'use client';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { RunTimeline as RunTimelineData, TimelineItem } from './types';

const ICONS: Record<string, string> = {
  'run.started': '▶', 'run.completed': '✅', 'run.failed': '❌', 'run.cancelled': '⏹', 'run.timeout': '⏰',
  'step.tool_call': '▸', 'step.final': '💬',
  'tool.started': '🔧', 'tool.completed': '🔧', 'tool.failed': '🔧',
  'task.created': '⏳', 'task.completed': '🖼', 'task.failed': '❌',
  'artifact.created': '📄',
  'usage.summary': '📊',
};

function fmtDuration(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function Row({ item }: { item: TimelineItem }) {
  return (
    <div className="flex items-start gap-2 py-1 text-xs">
      <span className="mt-0.5 w-4 shrink-0 text-center">{ICONS[item.type] ?? '•'}</span>
      <span className="min-w-0 flex-1">
        <span className={`font-medium ${item.status === 'failed' ? 'text-red-400' : 'text-zinc-300'}`}>{item.title}</span>
        {item.summary && <span className="ml-2 text-zinc-500">{item.summary}</span>}
      </span>
      {item.durationMs != null && <span className="shrink-0 text-zinc-600">{fmtDuration(item.durationMs)}</span>}
    </div>
  );
}

/** 最小 Run Timeline：折叠面板，后端投影 DTO 直渲（不做 IDE/Canvas） */
export function RunTimeline({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<RunTimelineData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !data) {
      setLoading(true); setError('');
      try {
        const res = await apiFetch<{ data: RunTimelineData }>(`/api/v1/agent-runs/${runId}/timeline`);
        setData(res.data);
      } catch {
        setError('时间线加载失败');
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="mt-1 rounded-lg border border-zinc-800/80 bg-zinc-900/40">
      <button onClick={() => void toggle()} className="flex w-full items-center gap-1 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        执行详情
        {data && <span className="ml-auto text-zinc-600">{data.items.length} 项 · {data.status}</span>}
      </button>
      {open && (
        <div className="border-t border-zinc-800/80 px-3 py-2">
          {loading && <p className="py-1 text-xs text-zinc-500">加载中…</p>}
          {error && <p className="py-1 text-xs text-red-400">{error}</p>}
          {data && (
            <div>
              {data.items.map((item) => <Row key={item.id} item={item} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
