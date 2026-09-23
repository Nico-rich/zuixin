'use client';
import { useEffect, useState } from 'react';
import { Image as ImageIcon, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api';

export interface TaskView {
  id: string;
  type: 'image' | 'video';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number | null;
  statusMessage: string | null;
  errorMessage: string | null;
}

/** 泛化任务卡片（kind 字段预留）：轮询 GET /tasks/:id 直到终态 */
export function TaskCard({ taskId, kind, onDone }: { taskId: string; kind: 'image' | 'video'; onDone?: (task: TaskView) => void }) {
  const [task, setTask] = useState<TaskView | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await apiFetch<{ data: TaskView }>(`/api/v1/tasks/${taskId}`);
        if (cancelled) return;
        setTask(res.data);
        if (['completed', 'failed', 'cancelled'].includes(res.data.status)) {
          onDone?.(res.data);
          return;
        }
      } catch { /* 网络抖动，下一轮继续 */ }
      timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [taskId, onDone]);

  const status = task?.status ?? 'pending';
  const progress = task?.progress ?? (status === 'processing' ? 10 : status === 'pending' ? 0 : null);
  const message = task?.statusMessage ?? (status === 'pending' ? '排队中…' : '生成中…');

  return (
    <div className="my-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="flex items-center gap-2 text-sm">
        <ImageIcon className="size-4 text-zinc-400" />
        <span className="text-zinc-200">{kind === 'image' ? '图片生成' : '视频生成'}</span>
        <span className="ml-auto text-xs text-zinc-500">
          {status === 'completed' && '✅ 完成'}
          {status === 'failed' && '❌ 失败'}
          {status === 'cancelled' && '⏹ 已取消'}
          {(status === 'pending' || status === 'processing') && (
            <span className="inline-flex items-center gap-1"><Loader2 className="size-3 animate-spin" />{message}</span>
          )}
        </span>
      </div>
      {(status === 'pending' || status === 'processing') && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div className="h-full rounded-full bg-zinc-400 transition-all" style={{ width: `${Math.min(progress ?? 10, 100)}%` }} />
        </div>
      )}
      {status === 'failed' && (
        <div className="mt-2 flex items-center gap-2 text-xs text-red-400">
          <XCircle className="size-3.5" />
          <span>{task?.errorMessage ?? '生成失败'}</span>
          <button className="ml-auto flex items-center gap-1 rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800" onClick={() => window.location.reload()}>
            <RotateCcw className="size-3" /> 重新发送
          </button>
        </div>
      )}
    </div>
  );
}
