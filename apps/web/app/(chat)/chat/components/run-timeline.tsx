'use client';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { RunTimeline as RunTimelineData, RunTimelineUsage, TimelineItem } from './types';

/**
 * 时间线项图标（api 侧 TimelineItemType 全类型覆盖；未命中才回退 '•'）。
 * M10-P13（审计 M9-18）：补上 run.waiting 与 approval.* 的专属图标——此前这些项一律显示兜底 '•'，
 * 用户看不出"等待任务"与"等待审批"的区别（M6-P4 任务等待、M7-P1 人工审批都会产出这些项）。
 */
const ICONS: Record<string, string> = {
  'run.started': '▶', 'run.completed': '✅', 'run.failed': '❌', 'run.cancelled': '⏹', 'run.timeout': '⏰',
  'run.waiting': '⏸',
  'step.tool_call': '▸', 'step.final': '💬',
  'tool.started': '🔧', 'tool.completed': '🔧', 'tool.failed': '🔧',
  'task.created': '⏳', 'task.completed': '🖼', 'task.failed': '❌',
  'artifact.created': '📄',
  'approval.requested': '🙋', 'approval.approved': '👍', 'approval.rejected': '👎',
  'approval.expired': '⌛', 'approval.cancelled': '🚫',
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

/* ------------------------------------------------------------------ *
 * M13-W10：usage 渲染
 *
 * 后端 `RunUsageAggregate`（apps/api/src/modules/usage/usage.service.ts）此前被 web 整体丢弃
 * （types.ts 定义了 RunTimelineUsage 但没有任何渲染点）→ 用户看不到 token/成本/媒体用量。
 * 这里只做**如实呈现**（不做预算判定、不四舍五入掉小额成本）：
 *  - 成本单位是计价事实源里的原始数值，小额成本保留有效数字（0.000048 不能显示成 0.00）；
 *  - 用量为 0 的维度仍显示（"0" 与"没有该维度"是两件事，绝不用空白冒充）；
 *  - `failedCalls > 0` 时显式告警（失败调用已计费/已计入用量事实表）。
 * ------------------------------------------------------------------ */

/** 成本格式化：按量级保有效数字，避免小额成本被抹成 0.00 */
function fmtCost(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0';
  const abs = Math.abs(value);
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

function fmtTokens(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : '0';
}

function Stat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warn' }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-zinc-600">{label}</span>
      <span className={tone === 'warn' ? 'font-medium text-amber-300' : 'font-medium text-zinc-300'}>{value}</span>
    </div>
  );
}

function UsagePanel({ usage }: { usage: RunTimelineUsage }) {
  return (
    <div className="mb-2 rounded border border-zinc-800/80 bg-zinc-950/40 px-2.5 py-2" data-testid="run-usage">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Stat label="耗时" value={fmtDuration(usage.durationMs)} />
        <Stat label="tokens" value={`${fmtTokens(usage.inputTokens)} 入 + ${fmtTokens(usage.outputTokens)} 出 = ${fmtTokens(usage.totalTokens)}`} />
        <Stat label="成本" value={`${fmtCost(usage.llmCost)} LLM + ${fmtCost(usage.imageCost)} 图片 + ${fmtCost(usage.videoCost)} 视频 = ${fmtCost(usage.totalCost)}`} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Stat label="LLM 轮次" value={String(usage.llmRounds)} />
        <Stat label="图片" value={`${usage.imageCount} 张`} />
        <Stat label="视频" value={`${usage.videoSeconds} 秒`} />
        <Stat label="失败调用" value={String(usage.failedCalls)} tone={usage.failedCalls > 0 ? 'warn' : 'default'} />
      </div>
      {usage.byKind.length > 0 && (
        <div className="mt-1.5 border-t border-zinc-800/60 pt-1.5 text-[11px] text-zinc-500">
          {usage.byKind.map((k) => (
            <span key={k.kind} className="mr-3 inline-block">
              <span className="font-mono text-zinc-400">{k.kind}</span>
              {' · '}{k.count} 次 · {fmtTokens(k.tokens)} tokens · {fmtCost(k.cost)}
            </span>
          ))}
        </div>
      )}
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
              {data.usage && <UsagePanel usage={data.usage} />}
              {data.items.map((item) => <Row key={item.id} item={item} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
