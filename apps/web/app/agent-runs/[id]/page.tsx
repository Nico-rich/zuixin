'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiRetryPolicy, useApiMutation, useApiQueryClient } from '@/lib/api';
import {
  agentRunKeys, cancelAgentRun, getAgentRun, getRunTimeline, retryAgentRun,
  type AgentRunDetail, type AgentRunStatus, type RunUsageAggregate,
  type RunTimeline as RunTimelineProjection,
} from '@/lib/services/agent-runs';
// 时间线的**权威渲染组件**：既有 chat 组件（不在本页复制一份，避免两份图标表/两份投影渲染）。
// 组件自带折叠与拉取（GET /agent-runs/:id/timeline），行为保持不变；本页只用它渲染 items。
import { RunTimeline } from '@/app/(chat)/chat/components/run-timeline';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

/**
 * Agent 运行详情（M13-W2）。
 *
 * 三条事实口径（与后端一致，页面不做任何推断）：
 *  ① 状态/时间/错误码 = AgentRun 行本身（GET /agent-runs/:id）；
 *  ② 步骤/工具调用/任务/产物 = 后端血缘投影（detail.steps / tasks / artifacts）——本页只呈现，不合成；
 *  ③ 用量 = usage_records 按 runId 的聚合（GET /agent-runs/:id/timeline 的 usage 字段），
 *    它是**执行成本的可观测估算**（estimatedCost），不是账单事实源（账单见 /billing）。
 *
 * 写操作只有两个，且严格遵循后端 409 语义：终态运行不可终止、非终态运行不可重试
 * （按钮在此前提下禁用并给出原因，避免让用户白点一次拿 409）。
 */
const TERMINAL: readonly AgentRunStatus[] = ['completed', 'failed', 'cancelled', 'timeout'];

const STATUS_VARIANT: Record<AgentRunStatus, BadgeProps['variant']> = {
  queued: 'secondary',
  running: 'info',
  waiting: 'warning',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'warning',
  timeout: 'warning',
};

const STATUS_TEXT: Record<AgentRunStatus, string> = {
  queued: '排队中',
  running: '执行中',
  waiting: '等待中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已终止',
  timeout: '超时',
};

function fmtDateTime(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function fmtDuration(ms?: number | null): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtNumber(n: number): string {
  return n.toLocaleString();
}

/** 成本：usage_records.estimatedCost 的投影（估算，非结算金额） */
function fmtCost(n: number): string {
  return n === 0 ? '$0' : `$${n.toFixed(4)}`;
}

/**
 * 步骤起始时间：后端 `GET /agent-runs/:id` 直接返回 Prisma 行（含 `startedAt`），
 * 而 web service 的 `AgentRunStep` 类型写的是 `createdAt`（字段名漂移，见 service 类型声明）。
 * 两个字段都读一次，避免运行时渲染成「—」。**不要**按类型里的 createdAt 单读。
 */
function stepStartedAt(step: { createdAt?: string; startedAt?: string }): string {
  return step.startedAt ?? step.createdAt ?? '';
}

/** 用量卡：token / 成本 / 媒体用量（全部来自后端聚合，缺失即显示 0） */
function UsagePanel({ usage }: { usage: RunUsageAggregate }) {
  const metrics: Array<[string, string]> = [
    ['总 token', fmtNumber(usage.totalTokens)],
    ['输入 token', fmtNumber(usage.inputTokens)],
    ['输出 token', fmtNumber(usage.outputTokens)],
    ['LLM 轮次', fmtNumber(usage.llmRounds)],
    ['LLM 成本', fmtCost(usage.llmCost)],
    ['图片', `${fmtNumber(usage.imageCount)} 张 · ${fmtCost(usage.imageCost)}`],
    ['视频', `${usage.videoSeconds}s · ${fmtCost(usage.videoCost)}`],
    ['合计估算', fmtCost(usage.totalCost)],
    ['失败调用', fmtNumber(usage.failedCalls)],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>用量</CardTitle>
        <CardDescription>usage_records 按运行聚合（估算成本，非账单事实源；账单见「账单」页）</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {metrics.map(([label, value]) => (
            <div key={label} className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2">
              <span className="block text-xs text-zinc-500">{label}</span>
              <span className="block text-sm text-zinc-200">{value}</span>
            </div>
          ))}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>类型</TableHead>
              <TableHead>调用数</TableHead>
              <TableHead>token</TableHead>
              <TableHead>成本</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usage.byKind.length === 0 && <TableEmpty colSpan={4}>该运行没有用量记录</TableEmpty>}
            {usage.byKind.map((k) => (
              <TableRow key={k.kind}>
                <TableCell className="font-mono text-xs">{k.kind}</TableCell>
                <TableCell className="text-xs">{fmtNumber(k.count)}</TableCell>
                <TableCell className="text-xs">{fmtNumber(k.tokens)}</TableCell>
                <TableCell className="text-xs">{fmtCost(k.cost)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function AgentRunDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  const router = useRouter();
  const queryClient = useApiQueryClient();
  const { toast } = useToast();

  const run = useQuery<{ data: AgentRunDetail }, ApiError>({
    queryKey: agentRunKeys.detail(id),
    queryFn: () => getAgentRun(id),
    enabled: id !== '',
    retry: apiRetryPolicy,
    // 非终态运行仍在推进 → 轮询刷新投影；终态后停止（0 次无谓请求）
    refetchInterval: (query) => {
      const status = query.state.data?.data.status;
      return status && !TERMINAL.includes(status) ? 5000 : false;
    },
  });

  const timeline = useQuery<{ data: RunTimelineProjection }, ApiError>({
    queryKey: agentRunKeys.timeline(id),
    queryFn: () => getRunTimeline(id),
    enabled: id !== '',
    retry: apiRetryPolicy,
  });

  const detail = run.data?.data;
  const usage = timeline.data?.data.usage ?? null;
  const steps = useMemo(() => detail?.steps ?? [], [detail]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: agentRunKeys.all });
    void queryClient.invalidateQueries({ queryKey: agentRunKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: agentRunKeys.timeline(id) });
  };

  const cancel = useApiMutation(() => cancelAgentRun(id), {
    onSuccess: () => {
      toast({ title: '已请求终止该运行', variant: 'success' });
      invalidate();
    },
    onError: (err) => toast({ title: '终止失败', description: err.message, variant: 'error' }),
  });

  const retry = useApiMutation(() => retryAgentRun(id), {
    onSuccess: (res) => {
      toast({ title: '已发起重试', description: `新运行 ${res.data.runId.slice(0, 8)}（第 ${res.data.attempt} 次尝试）`, variant: 'success' });
      invalidate();
      router.push(`/agent-runs/${res.data.runId}`);
    },
    onError: (err) => toast({ title: '重试失败', description: err.message, variant: 'error' }),
  });

  if (run.isPending) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-3 px-4 py-8" aria-busy>
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  if (run.isError || !detail) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2">
            <span className="text-sm text-red-300">
              运行详情加载失败：{run.error?.message ?? '未知错误'}
              {run.error?.code === 'FORBIDDEN' && '（该运行不属于当前用户）'}
            </span>
            <Button variant="outline" size="sm" onClick={() => void run.refetch()}>重试</Button>
          </div>
          <p className="mt-4 text-xs text-zinc-500">
            返回 <Link href="/agent-runs" className="text-sky-400 hover:underline">Agent 运行列表</Link>
          </p>
        </div>
      </div>
    );
  }

  const isTerminal = TERMINAL.includes(detail.status);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-lg font-semibold text-zinc-100">运行详情</h1>
          <Link href="/agent-runs" className="text-xs text-sky-400 hover:underline">返回列表</Link>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="font-mono">{detail.id}</CardTitle>
            <CardDescription>
              {detail.agent ? `${detail.agent.name}（${detail.agent.slug}）` : detail.agentId}
              {detail.agentVersion && ` · 版本 v${detail.agentVersion.version}（${detail.agentVersion.status}）`}
              {detail.conversationId && ` · 会话 ${detail.conversationId.slice(0, 8)}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS_VARIANT[detail.status] ?? 'default'}>{STATUS_TEXT[detail.status] ?? detail.status}</Badge>
              <Badge variant="outline">第 {detail.attempt} 次尝试</Badge>
              <Badge variant="outline">步骤 {detail.currentStep}/{detail.maxSteps}</Badge>
              {detail.retryOfRunId && (
                <Link href={`/agent-runs/${detail.retryOfRunId}`} className="text-xs text-sky-400 hover:underline">
                  重试自 {detail.retryOfRunId.slice(0, 8)}
                </Link>
              )}
              {detail.parentRunId && <span className="text-xs text-zinc-500">父运行 {detail.parentRunId.slice(0, 8)}</span>}
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {([
                ['创建时间', fmtDateTime(detail.createdAt)],
                ['开始时间', fmtDateTime(detail.startedAt)],
                ['完成时间', fmtDateTime(detail.completedAt)],
                ['耗时', fmtDuration(usage?.durationMs)],
                ['任务数', fmtNumber(detail.tasks.length)],
                ['产物数', fmtNumber(detail.artifacts.length)],
              ] as Array<[string, string]>).map(([label, value]) => (
                <div key={label} className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2">
                  <span className="block text-xs text-zinc-500">{label}</span>
                  <span className="block text-sm text-zinc-200">{value}</span>
                </div>
              ))}
            </div>

            {(detail.errorCode || detail.errorMessage) && (
              <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2">
                <span className="block text-xs text-red-300">失败原因：{detail.errorCode ?? 'ERROR'}</span>
                {detail.errorMessage && <span className="mt-0.5 block text-xs text-red-300/80">{detail.errorMessage}</span>}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={isTerminal || cancel.isPending}
                title={isTerminal ? '终态运行不可终止（后端返回 409）' : '请求终止该运行'}
                onClick={() => cancel.mutate()}
              >
                终止本次执行
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!isTerminal || retry.isPending}
                title={isTerminal ? '以该运行为源发起一次新的执行' : '执行中的运行不可重试（后端返回 409）'}
                onClick={() => retry.mutate()}
              >
                重试本次执行
              </Button>
              <span className="text-xs text-zinc-500">
                {isTerminal ? '终态：可重试，不可终止' : '执行中：可终止，不可重试'}
              </span>
            </div>
          </CardContent>
        </Card>

        {timeline.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : timeline.isError ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2">
            <span className="text-sm text-red-300">时间线/用量加载失败：{timeline.error.message}</span>
            <Button variant="outline" size="sm" onClick={() => void timeline.refetch()}>重试</Button>
          </div>
        ) : usage ? (
          <UsagePanel usage={usage} />
        ) : (
          <Card>
            <CardHeader><CardTitle>用量</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-zinc-500">该运行没有用量记录（未产生 LLM/媒体调用，或记录尚未落库）。</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>步骤</CardTitle>
            <CardDescription>Run → Step → ToolCall 血缘投影（后端返回，本页不合成）</CardDescription>
          </CardHeader>
          <CardContent className="px-0 py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>工具调用</TableHead>
                  <TableHead>开始</TableHead>
                  <TableHead>完成</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {steps.length === 0 && <TableEmpty colSpan={6}>暂无步骤记录</TableEmpty>}
                {steps.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="text-xs text-zinc-400">{s.stepIndex}</TableCell>
                    <TableCell className="font-mono text-xs">{s.type}</TableCell>
                    <TableCell className="text-xs">{s.status}</TableCell>
                    <TableCell className="text-xs text-zinc-400">{s.toolCalls?.length ?? 0}</TableCell>
                    <TableCell className="text-xs text-zinc-400">{fmtDateTime(stepStartedAt(s))}</TableCell>
                    <TableCell className="text-xs text-zinc-400">{fmtDateTime(s.completedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>执行时间线</CardTitle>
            <CardDescription>复用对话页的时间线组件（GET /agent-runs/:id/timeline 投影）</CardDescription>
          </CardHeader>
          <CardContent>
            <RunTimeline runId={id} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
