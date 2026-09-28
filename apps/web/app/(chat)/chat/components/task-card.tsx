'use client';
import { useEffect, useRef, useState } from 'react';
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

/**
 * 线上 SSE 任务事件（shared/events.ts 的 task.progress / task.completed，payload 由 api 的
 * task 通道转发器原样透传——不新造字段）。task-card 只消费与本卡片 taskId 相同的事件。
 */
export interface TaskStreamEvent {
  type: 'task.progress' | 'task.completed';
  taskId: string;
  progress?: number;
  message?: string;
}

/** 无 SSE 事件时的兜底轮询间隔（M2 以来的行为，降级路径不变） */
const POLL_MS = 2000;
/** SSE 事件新鲜度窗口：窗口内有事件 → 实时面由 SSE 承担，轮询只保持待命（不发请求） */
const SSE_FRESH_MS = 10_000;
const TERMINAL = ['completed', 'failed', 'cancelled'];

/**
 * 泛化任务卡片（kind 字段预留）。
 *
 * M10-P13（审计 ARCH-07）：**SSE 优先 + 轮询兜底**。
 * - SSE 面：worker 把 task.progress（进度/文案）与 task.completed 发布到 Redis `task` 通道，
 *   api 的 SSE 转发器按 user/conversation 路由到本页已建立的 SSE 连接，chat-workspace 把事件透传给本卡片
 *   → 进度即时上屏，不再依赖 2s 轮询；
 * - 轮询面：SSE 静默（未收到事件 / 事件中断 / Redis 不可用的降级连接）时每 2s 拉取 GET /tasks/:id；
 *   收到终态类事件后立刻做一次 DB 对账（**SSE 是信号，DB 才是事实源**：失败态/附件以行为准）。
 */
export function TaskCard({ taskId, kind, onDone, event }: {
  taskId: string;
  kind: 'image' | 'video';
  onDone?: (task: TaskView) => void;
  /** 当前任务的最新 SSE 事件（无 SSE 时传 null/不传 → 走轮询兜底） */
  event?: TaskStreamEvent | null;
}) {
  const [task, setTask] = useState<TaskView | null>(null);
  const [live, setLive] = useState<Pick<TaskView, 'status' | 'progress' | 'statusMessage'> | null>(null);
  const lastEventAt = useRef(0);
  const needsConfirm = useRef(false);
  const kick = useRef<(() => void) | null>(null);

  // SSE 事件：即时更新展示，并请求轮询循环立刻做一次 DB 对账
  useEffect(() => {
    if (!event || event.taskId !== taskId) return;
    lastEventAt.current = Date.now();
    needsConfirm.current = true;
    setLive({
      status: event.type === 'task.completed' ? 'completed' : 'processing',
      progress: typeof event.progress === 'number' ? event.progress : null,
      statusMessage: event.message ?? null,
    });
    kick.current?.();
  }, [event, taskId]);

  useEffect(() => {
    let cancelled = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (ms: number) => { timer = setTimeout(() => void tick(), ms); };
    const tick = async () => {
      if (cancelled || finished) return;
      // SSE 健康且无待对账信号 → 本轮跳过网络请求（轮询降级为兜底，不做无谓往返）
      if (Date.now() - lastEventAt.current < SSE_FRESH_MS && !needsConfirm.current) { schedule(POLL_MS); return; }
      needsConfirm.current = false;
      try {
        const res = await apiFetch<{ data: TaskView }>(`/api/v1/tasks/${taskId}`);
        if (cancelled) return;
        setTask(res.data);
        if (TERMINAL.includes(res.data.status)) {
          finished = true;
          onDone?.(res.data);
          return;
        }
      } catch { /* 网络抖动，下一轮继续 */ }
      if (!cancelled) schedule(POLL_MS);
    };
    // SSE 事件驱动的提前对账（清掉待命定时器，立即跑一轮）
    kick.current = () => { if (timer) clearTimeout(timer); void tick(); };
    void tick();
    return () => {
      cancelled = true;
      kick.current = null;
      if (timer) clearTimeout(timer);
    };
  }, [taskId, onDone]);

  const dbTerminal = task != null && TERMINAL.includes(task.status);
  const status = dbTerminal ? task!.status : (live?.status ?? task?.status ?? 'pending');
  const progress = live?.progress ?? task?.progress ?? (status === 'processing' ? 10 : status === 'pending' ? 0 : null);
  const message = live?.statusMessage ?? task?.statusMessage ?? (status === 'pending' ? '排队中…' : '生成中…');

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
