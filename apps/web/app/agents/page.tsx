'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiRetryPolicy } from '@/lib/api';
import { agentKeys, listAgents, type Agent } from '@/lib/services/agents';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AgentCreateDialog } from './components/agent-create-dialog';

/**
 * Agents 管理（M13-W2）——列表页。
 *
 * **后端全控制器 `@Roles('admin')`**（agents-admin.controller.ts）：非管理员必然 403。
 * 页面不做任何权限判定（服务端才是裁决方），但必须**如实呈现 403**：
 * 明确告诉用户「需要管理员权限」，不伪装成空列表、不静默重试。
 *
 * 列表 = Agent 行 + 版本投影（后端 list 已 include activeVersion 与全部 versions），本页不合成。
 */
function fmtDateTime(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function kindText(agent: Agent): string {
  const kind = agent.kind === 'builtin' ? '内置' : agent.kind === 'custom' ? '自定义' : agent.kind;
  const scope = agent.scope === 'system' ? '系统级' : agent.scope === 'organization' ? '组织级' : agent.scope === 'user' ? '用户级' : agent.scope;
  return `${kind} · ${scope}`;
}

export default function AgentsPage() {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);

  const agents = useQuery<{ data: Agent[] }, ApiError>({
    queryKey: agentKeys.all,
    queryFn: listAgents,
    retry: apiRetryPolicy,
  });

  const items = useMemo(() => agents.data?.data ?? [], [agents.data]);
  /** 403：服务端 RolesGuard 的裁决结果（不是前端推断） */
  const forbidden = agents.error?.code === 'FORBIDDEN';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex items-baseline justify-between gap-4">
          <h1 className="text-lg font-semibold text-zinc-100">Agents</h1>
          {/* 403 时不渲染写入口：非管理员点它只会拿到同一个 403（服务端才是裁决方） */}
          {!forbidden && <Button size="sm" onClick={() => setCreateOpen(true)}>添加 Agent</Button>}
        </div>

        {agents.isPending ? (
          <div className="space-y-2" aria-busy>
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : agents.isError ? (
          forbidden ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Badge variant="warning">需要管理员权限</Badge>
                  <span>无权读取 Agent 列表</span>
                </CardTitle>
                <CardDescription>
                  Agents 管理接口仅对管理员开放（服务端 RolesGuard 返回 403 FORBIDDEN）。
                  当前账号的角色不具备该权限——如需管理 Agent，请用管理员账号登录。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-zinc-500">服务端返回：{agents.error.message}</span>
                <Button variant="outline" size="sm" onClick={() => void agents.refetch()}>重试</Button>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2">
              <span className="text-sm text-red-300">Agent 列表加载失败：{agents.error.message}</span>
              <Button variant="outline" size="sm" onClick={() => void agents.refetch()}>重试</Button>
            </div>
          )
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Agent 注册表</CardTitle>
              <CardDescription>共 {items.length} 个 · 版本只有在「上线」后才生效（运行锁定的版本永不变更）</CardDescription>
            </CardHeader>
            <CardContent className="px-0 py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>slug</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>生效版本</TableHead>
                    <TableHead>版本数</TableHead>
                    <TableHead>更新时间</TableHead>
                    <TableHead>详情</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.length === 0 && <TableEmpty colSpan={8}>暂无 Agent</TableEmpty>}
                  {items.map((agent) => (
                    <TableRow key={agent.id}>
                      <TableCell className="font-medium text-zinc-200">{agent.name}</TableCell>
                      <TableCell className="font-mono text-xs text-zinc-400">{agent.slug}</TableCell>
                      <TableCell className="text-xs text-zinc-400">{kindText(agent)}</TableCell>
                      <TableCell>
                        {agent.enabled
                          ? <Badge variant="success">已启用</Badge>
                          : <Badge variant="secondary">已停用</Badge>}
                      </TableCell>
                      <TableCell className="text-xs text-zinc-400">
                        {agent.activeVersion ? `v${agent.activeVersion.version}` : '无（未上线）'}
                      </TableCell>
                      <TableCell className="text-xs text-zinc-400">{agent.versions?.length ?? 0}</TableCell>
                      <TableCell className="text-xs text-zinc-400">{fmtDateTime(agent.updatedAt)}</TableCell>
                      <TableCell>
                        <Link href={`/agents/${agent.id}`} className="text-xs text-sky-400 hover:underline">查看</Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      <AgentCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => { if (id) router.push(`/agents/${id}`); }}
      />
    </div>
  );
}
