'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { conversationKeys, listConversations } from '@/lib/services/conversations';
import { agentRunKeys, listAgentRuns } from '@/lib/services/agent-runs';
import { getRunUsage, usageKeys } from '@/lib/services/usage';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { SkeletonLines } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtCost, fmtDateTime, fmtDecimal, fmtDurationMs, fmtInt } from '@/components/metrics-format';

/**
 * /usage（M13-W6）——Run 级用量查看：会话 → Agent 运行 → 该 run 的用量聚合。
 *
 * 事实源口径（红线：UsageRecord 是唯一计费事实源）：
 *  - 本页只消费 `GET /api/v1/usage/agent-runs/:id`（UsageRecord 的按 run 聚合视图），
 *    **没有任何金额/倍率计算**——所有数字原样来自服务端；
 *  - usage 模块当前只有这一个端点：组织级口径请走「分析」（analytics facts.usage，含分层元信息）
 *    或「账单」（账本口径 UsageLedgerEntry）。本页不做组织级汇总，也不与账本相加（避免双计）。
 */

const STATUS_BADGE: Record<string, 'default' | 'info' | 'success' | 'destructive' | 'warning'> = {
  queued: 'default',
  running: 'info',
  waiting: 'warning',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'warning',
  timeout: 'destructive',
};

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="py-2">
        <p className="text-xs text-zinc-400">{label}</p>
        <p className="mt-1 text-lg font-semibold text-zinc-100">{value}</p>
        {hint && <p className="mt-0.5 font-mono text-[10px] text-zinc-600">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export default function UsagePage() {
  const [conversationId, setConversationId] = useState('');
  const [runId, setRunId] = useState('');

  const conversations = useQuery({
    queryKey: conversationKeys.list(null),
    queryFn: () => listConversations({ limit: 20 }),
  });
  const runs = useQuery({
    queryKey: agentRunKeys.list(conversationId),
    queryFn: () => listAgentRuns(conversationId),
    enabled: conversationId.length > 0,
  });

  const conversationRows = conversations.data?.data ?? [];
  const runRows = runs.data?.data ?? [];
  // 选择态收敛：上一次选的 run 不属于当前会话时，回落到该会话第一个 run（不做隐式跨会话取数）
  const selectedRunId = runRows.some((run) => run.id === runId) ? runId : (runRows[0]?.id ?? '');

  const usage = useQuery({
    queryKey: usageKeys.run(selectedRunId),
    queryFn: () => getRunUsage(selectedRunId),
    enabled: selectedRunId.length > 0,
  });
  const aggregate = usage.data?.data;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">用量</h1>
        <p className="mt-1 text-xs text-zinc-500">
          Run 级用量聚合（事实源：UsageRecord；页面不做任何金额/倍率计算）。
          组织级口径见 <Link href="/analytics" className="text-zinc-300 underline-offset-2 hover:underline">分析</Link> 与
          <Link href="/billing" className="ml-1 text-zinc-300 underline-offset-2 hover:underline">账单</Link>。
        </p>
      </div>

      <section aria-labelledby="usage-picker-heading" className="mb-8">
        <div className="mb-1 flex items-center gap-2">
          <h2 id="usage-picker-heading" className="text-sm font-medium text-zinc-200">选择运行</h2>
          <Badge variant="outline">两步定位</Badge>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          列表端点要求 conversationId（`GET /agent-runs?conversationId=…` 为必填），故先选会话再选运行。
        </p>
        <Card>
          <CardContent className="grid grid-cols-1 gap-3 pt-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">会话</span>
              <Select
                aria-label="会话"
                value={conversationId}
                onChange={(event) => { setConversationId(event.target.value); setRunId(''); }}
              >
                <option value="">请选择会话</option>
                {conversationRows.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversation.title || '（无标题）'} · {fmtDateTime(conversation.updatedAt)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">Agent 运行</span>
              <Select
                aria-label="Agent 运行"
                disabled={conversationId.length === 0 || runRows.length === 0}
                value={selectedRunId}
                onChange={(event) => setRunId(event.target.value)}
              >
                {runRows.length === 0 && <option value="">{conversationId ? '该会话暂无运行' : '请先选择会话'}</option>}
                {runRows.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.status} · {fmtDateTime(run.createdAt)} · {run.id.slice(0, 8)}
                  </option>
                ))}
              </Select>
            </label>
          </CardContent>
        </Card>

        {conversations.isPending && <div className="mt-3"><SkeletonLines lines={2} /></div>}
        {conversations.isError && <p className="mt-3 text-sm text-red-400">会话列表加载失败：{conversations.error.message}</p>}
        {conversations.data && conversationRows.length === 0 && (
          <p className="mt-3 text-xs text-zinc-500">暂无会话——先到「对话」创建会话并触发一次 Agent 运行。</p>
        )}
        {runs.isError && <p className="mt-3 text-sm text-red-400">运行列表加载失败：{runs.error.message}</p>}
        {runs.data && runRows.length === 0 && <p className="mt-3 text-xs text-zinc-500">该会话暂无 Agent 运行。</p>}
      </section>

      <section data-testid="run-usage" aria-labelledby="run-usage-heading" className="mb-8">
        <div className="mb-1 flex items-center gap-2">
          <h2 id="run-usage-heading" className="text-sm font-medium text-zinc-200">Run 用量</h2>
          <Badge variant="info">事实</Badge>
          <Badge variant="outline">UsageRecord 聚合</Badge>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          按 run 聚合的 token / 成本 / 媒体用量 / 时长（服务端 projection：不建汇总表，读时聚合）。
        </p>

        {selectedRunId === '' && <p className="text-xs text-zinc-500">请选择会话与运行以查看用量。</p>}
        {usage.isPending && selectedRunId !== '' && <SkeletonLines lines={4} />}
        {usage.isError && <p className="p-4 text-sm text-red-400">用量加载失败：{usage.error.message}</p>}

        {aggregate && (
          <>
            <p className="mb-3 text-xs text-zinc-500">
              runId <span className="font-mono text-zinc-300">{aggregate.runId}</span>
            </p>

            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="总成本" value={fmtCost(aggregate.totalCost)} hint="totalCost" />
              <StatCard label="LLM 成本" value={fmtCost(aggregate.llmCost)} hint="llmCost" />
              <StatCard label="图像成本" value={fmtCost(aggregate.imageCost)} hint="imageCost" />
              <StatCard label="视频成本" value={fmtCost(aggregate.videoCost)} hint="videoCost" />
            </div>

            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatCard label="输入 token" value={fmtInt(aggregate.inputTokens)} hint="inputTokens" />
              <StatCard label="输出 token" value={fmtInt(aggregate.outputTokens)} hint="outputTokens" />
              <StatCard label="合计 token" value={fmtInt(aggregate.totalTokens)} hint="totalTokens" />
            </div>

            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <StatCard label="时长" value={fmtDurationMs(aggregate.durationMs)} hint="durationMs" />
              <StatCard label="LLM 轮次" value={fmtInt(aggregate.llmRounds)} hint="llmRounds" />
              <StatCard label="出图数" value={fmtInt(aggregate.imageCount)} hint="imageCount" />
              <StatCard label="视频秒数" value={fmtDecimal(aggregate.videoSeconds, 2)} hint="videoSeconds" />
              <StatCard label="失败调用" value={fmtInt(aggregate.failedCalls)} hint="failedCalls" />
            </div>

            <Card>
              <CardHeader><CardTitle>按类型明细（byKind）</CardTitle></CardHeader>
              <CardContent className="pt-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>类型</TableHead>
                      <TableHead>调用次数</TableHead>
                      <TableHead>token</TableHead>
                      <TableHead>成本</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {aggregate.byKind.length === 0 && <TableEmpty colSpan={4}>该 run 暂无用量记录</TableEmpty>}
                    {aggregate.byKind.map((row) => (
                      <TableRow key={row.kind}>
                        <TableCell className="whitespace-nowrap font-mono text-xs">{row.kind}</TableCell>
                        <TableCell className="text-xs">{fmtInt(row.count)}</TableCell>
                        <TableCell className="text-xs">{fmtInt(row.tokens)}</TableCell>
                        <TableCell className="text-xs">{fmtCost(row.cost)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </section>

      <p className="text-[11px] text-zinc-600">
        口径：run 级视图只反映「该 run」的 UsageRecord 聚合；组织级计费事实与账本对账请走账单页（UsageLedgerEntry），
        本页数值不与账本做任何相加或换算（避免双计）。
      </p>
    </div>
  );
}
