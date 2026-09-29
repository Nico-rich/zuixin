'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { WriteError, toApiError } from '@/components/write-error';

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

/** 与服务端 workflow-runs.service.ts 的状态集合逐字对齐（cancel 只对 ACTIVE 生效，retry 只对 TERMINAL 生效） */
const ACTIVE = ['queued', 'running', 'waiting'];
const TERMINAL = ['completed', 'failed', 'cancelled', 'timeout'];

/** 最小 Run 列表（M7-P6）+ 行内生命周期（M13-W10）：取消(POST runs/:id/cancel) / 重试(POST runs/:id/retry) */
export default function WorkflowRunsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState<WorkflowRunSummary | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  /** 两个失败出口各自独立：取消的失败属于弹窗、重试的失败属于行内（同一份状态会在两处重复渲染） */
  const [cancelError, setCancelError] = useState<ApiError | null>(null);
  const [retryError, setRetryError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: WorkflowRunSummary[] }>(`/api/v1/workflows/${id}/runs?take=50`);
      setRuns(res.data);
      setError('');
    } catch {
      setError('运行列表加载失败');
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const confirmCancel = async () => {
    if (!cancelling) return;
    setActingId(cancelling.id); setCancelError(null);
    try {
      await apiFetch(`/api/v1/workflows/runs/${cancelling.id}/cancel`, { method: 'POST' });
      setCancelling(null);
      await load();
    } catch (err) {
      // 409 WORKFLOW_RUN_NOT_CANCELLABLE（已被别处/别处完成）也如实呈现，不装作成功
      setCancelError(toApiError(err, '取消失败，请重试'));
    } finally { setActingId(null); }
  };

  const retry = async (run: WorkflowRunSummary) => {
    setActingId(run.id); setRetryError(null);
    try {
      await apiFetch(`/api/v1/workflows/runs/${run.id}/retry`, { method: 'POST' });
      await load();
    } catch (err) {
      setRetryError(toApiError(err, '重试失败，请重试'));
    } finally { setActingId(null); }
  };

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (!runs) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-lg font-semibold text-zinc-100">运行历史</h1>
        <Link href={`/workflows/${id}`} className="text-xs text-zinc-500 hover:text-zinc-300">← 返回工作流</Link>
      </div>
      <WriteError error={retryError} className="mb-3" />
      {runs.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">暂无运行</p>}
      <ul className="space-y-2">
        {runs.map((r) => (
          <li key={r.id} className="flex items-center gap-2">
            <Link href={`/workflows/runs/${r.id}`}
              className="flex flex-1 items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-sm transition hover:border-zinc-700">
              <span className={`w-16 shrink-0 text-xs ${STATUS_STYLE[r.status] ?? 'text-zinc-400'}`}>{r.status}</span>
              <span className="text-xs text-zinc-500">{r.triggerType} · v{r.version.version} · 第 {r.attempt} 次</span>
              <span className="ml-auto text-xs text-zinc-600">{new Date(r.createdAt).toLocaleString()}</span>
            </Link>
            {ACTIVE.includes(r.status) && (
              <button
                onClick={() => { setCancelError(null); setCancelling(r); }}
                disabled={actingId === r.id}
                className="shrink-0 rounded border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 transition hover:border-red-800/60 hover:text-red-300 disabled:opacity-40"
                title="终止这个仍在执行的运行"
              >
                取消
              </button>
            )}
            {TERMINAL.includes(r.status) && (
              <button
                onClick={() => void retry(r)}
                disabled={actingId === r.id}
                className="shrink-0 rounded border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200 disabled:opacity-40"
                title="以同一输入新建一次运行（attempt +1）"
              >
                {actingId === r.id ? '重试中…' : '重试'}
              </button>
            )}
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => { if (!open) { setCancelling(null); setCancelError(null); } }}
        title="取消运行"
        description={`将终止运行 ${cancelling?.id ?? ''}（状态改为 cancelled，释放配额预留与等待中的审批/Agent 运行）。已产生的步骤结果不会回滚。`}
        confirmLabel="取消运行"
        cancelLabel="返回"
        destructive
        pending={actingId !== null}
        error={cancelError}
        forbiddenHint="需要 workflow.write 权限"
        onConfirm={() => void confirmCancel()}
      />
    </div>
  );
}
