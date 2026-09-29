'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiRetryPolicy } from '@/lib/api';
import type { PageMeta } from '@/lib/api';
import { agentRunKeys, listAgentRuns, type AgentRun, type AgentRunStatus } from '@/lib/services/agent-runs';
import { conversationKeys, listConversations, type Conversation } from '@/lib/services/conversations';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * Agent 运行列表（M13-W2）——**按会话查看**。
 *
 * 事实源：`GET /api/v1/agent-runs?conversationId=…`（agent-runs service）——该端点的
 * `conversationId` 是**必填**（缺失 → 400 VALIDATION_ERROR），所以页面必须先选会话：
 * 未选会话时呈现引导态，**不去猜**任何默认会话（选了就等于替用户声明了查询范围）。
 *
 * 列表行是投影：状态/步骤计数/尝试次数都直接来自后端 AgentRun 行，本页不做任何推断，
 * 也不把「运行中」当成「成功」之类的乐观状态。
 */
const RUN_STATUS_VARIANT: Record<AgentRunStatus, BadgeProps['variant']> = {
  queued: 'secondary',
  running: 'info',
  waiting: 'warning',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'warning',
  timeout: 'warning',
};

const RUN_STATUS_TEXT: Record<AgentRunStatus, string> = {
  queued: '排队中',
  running: '执行中',
  waiting: '等待中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已终止',
  timeout: '超时',
};

/** 终态：与后端 cancel/retry 的 409 语义一致（终态不可取消；非终态不可重试） */
const TERMINAL: readonly AgentRunStatus[] = ['completed', 'failed', 'cancelled', 'timeout'];

function fmtDateTime(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/** 耗时：优先 completedAt-startedAt；进行中则显示开始时间起的相对值 */
function fmtElapsed(run: AgentRun): string {
  if (!run.startedAt) return '—';
  const start = new Date(run.startedAt).getTime();
  const end = run.completedAt ? new Date(run.completedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—';
  const ms = end - start;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function conversationLabel(c: Conversation): string {
  return `${c.title || c.id} · ${fmtDateTime(c.updatedAt)}`;
}

export default function AgentRunsPage() {
  const [conversationId, setConversationId] = useState('');

  // 会话选择器数据源（游标分页；本页取最近 50 条，够选即可——不做全量拉取）
  const conversations = useQuery<{ data: Conversation[]; meta: PageMeta }, ApiError>({
    queryKey: conversationKeys.list(null),
    queryFn: () => listConversations({ limit: 50 }),
    retry: apiRetryPolicy,
  });
  const conversationItems = useMemo(() => conversations.data?.data ?? [], [conversations.data]);

  const runs = useQuery<{ data: AgentRun[] }, ApiError>({
    queryKey: agentRunKeys.list(conversationId),
    queryFn: () => listAgentRuns(conversationId),
    enabled: conversationId !== '',
    retry: apiRetryPolicy,
  });
  const items = useMemo(() => runs.data?.data ?? [], [runs.data]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex items-baseline justify-between gap-4">
          <h1 className="text-lg font-semibold text-zinc-100">Agent 运行</h1>
          <span className="text-xs text-zinc-500">按会话查看 · 时间线为投影（事实源 = Run/Step/ToolCall）</span>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>选择会话</CardTitle>
            <CardDescription>
              运行记录按会话归档——列表接口要求 conversationId（缺失会被后端拒绝），故需先选一条会话。
            </CardDescription>
          </CardHeader>
          <CardContent>
            {conversations.isPending ? (
              <Skeleton className="h-10 w-full max-w-md" />
            ) : conversations.isError ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2">
                <span className="text-sm text-red-300">会话列表加载失败：{conversations.error.message}</span>
                <Button variant="outline" size="sm" onClick={() => void conversations.refetch()}>重试</Button>
              </div>
            ) : conversationItems.length === 0 ? (
              <p className="text-sm text-zinc-500">暂无可选会话。先在「对话」页发起一次会话后回到本页。</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <label htmlFor="agent-runs-conversation" className="text-xs text-zinc-400">会话</label>
                <Select
                  id="agent-runs-conversation"
                  aria-label="会话"
                  className="max-w-md"
                  value={conversationId}
                  onChange={(e) => setConversationId(e.target.value)}
                >
                  <option value="">请选择会话</option>
                  {conversationItems.map((c) => (
                    <option key={c.id} value={c.id}>{conversationLabel(c)}</option>
                  ))}
                </Select>
              </div>
            )}
          </CardContent>
        </Card>

        {conversationId === '' ? (
          <Card>
            <CardHeader><CardTitle>尚未选择会话</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-zinc-500">
                选择一条会话后，这里会列出该会话下的 Agent 运行：状态、步骤进度、尝试次数与耗时。
                运行详情页可终止/重试，并查看时间线与用量。
              </p>
            </CardContent>
          </Card>
        ) : runs.isPending ? (
          <div className="space-y-2" aria-busy>
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : runs.isError ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2">
            <span className="text-sm text-red-300">运行列表加载失败：{runs.error.message}</span>
            <Button variant="outline" size="sm" onClick={() => void runs.refetch()}>重试</Button>
          </div>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>运行记录</CardTitle>
              <CardDescription>最近 20 条（createdAt 倒序）</CardDescription>
            </CardHeader>
            <CardContent className="px-0 py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>运行</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>步骤</TableHead>
                    <TableHead>尝试</TableHead>
                    <TableHead>开始时间</TableHead>
                    <TableHead>耗时</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.length === 0 && <TableEmpty colSpan={7}>该会话暂无 Agent 运行</TableEmpty>}
                  {items.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>
                        <Link href={`/agent-runs/${run.id}`} className="font-mono text-xs text-sky-400 hover:underline" title={run.id}>
                          {run.id.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs">{run.agent ? `${run.agent.name}（${run.agent.slug}）` : run.agentId}</TableCell>
                      <TableCell>
                        <Badge variant={RUN_STATUS_VARIANT[run.status] ?? 'default'}>
                          {RUN_STATUS_TEXT[run.status] ?? run.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-zinc-400">{run.currentStep}/{run.maxSteps}</TableCell>
                      <TableCell className="text-xs text-zinc-400">
                        {run.attempt}
                        {run.retryOfRunId && <span className="ml-1 text-zinc-600">（重试）</span>}
                      </TableCell>
                      <TableCell className="text-xs text-zinc-400">{fmtDateTime(run.startedAt ?? run.createdAt)}</TableCell>
                      <TableCell className="text-xs text-zinc-400">
                        {TERMINAL.includes(run.status) ? fmtElapsed(run) : `${fmtElapsed(run)}…`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
