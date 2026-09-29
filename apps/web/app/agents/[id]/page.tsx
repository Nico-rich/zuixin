'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiRetryPolicy, useApiMutation, useApiQueryClient } from '@/lib/api';
import {
  agentKeys, getAgent, publishAgent, rollbackAgent, setAgentEnabled,
  type Agent, type AgentVersion,
} from '@/lib/services/agents';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { AgentDraftDialog } from '../components/agent-draft-dialog';
import { AGENT_TOOL_CATALOG, toStringArray } from '../tool-catalog';

/**
 * Agent 详情 / 版本生命周期（M13-W2；**仅 admin**，403 如实呈现）。
 *
 * 生命周期事实（agents-admin.service）：定义只存在于 AgentVersion；published/archived 不可变；
 * 「编辑」= 改草稿（没有草稿就基于生效版本复制出 n+1）→「上线」= draft 转 published（旧 published 转 archived，
 * 并切换 activeVersionId）；「回滚」= activeVersionId 指回某个已发布/归档版本（零复制）。
 * AgentRun 在创建时锁定 agentVersionId，此后永不改变 —— 这一点在页面上明确写出，避免误读「回滚会影响历史运行」。
 */
const VERSION_VARIANT: Record<string, BadgeProps['variant']> = {
  draft: 'warning',
  published: 'success',
  archived: 'secondary',
};

const VERSION_TEXT: Record<string, string> = {
  draft: '草稿',
  published: '已上线',
  archived: '已归档',
};

function fmtDateTime(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function configText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 版本详情面板：只呈现该版本的字段（systemPrompt/tools/参数/config 原文） */
function VersionPanel({ version, isActive }: { version: AgentVersion; isActive: boolean }) {
  const tools = toStringArray(version.tools);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>版本 v{version.version}</span>
          <Badge variant={VERSION_VARIANT[version.status] ?? 'default'}>{VERSION_TEXT[version.status] ?? version.status}</Badge>
          {isActive && <Badge variant="info">当前生效</Badge>}
        </CardTitle>
        <CardDescription>
          创建于 {fmtDateTime(version.createdAt)} · temperature {version.temperature} · maxTokens {version.maxTokens ?? '不限制'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <span className="mb-1 block text-xs text-zinc-500">systemPrompt</span>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-300">{version.systemPrompt}</pre>
        </div>
        <div>
          <span className="mb-1 block text-xs text-zinc-500">工具（{tools.length}）</span>
          {tools.length === 0 ? (
            <p className="text-xs text-zinc-500">该版本未绑定工具</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {tools.map((t) => (
                <Badge key={t} variant={AGENT_TOOL_CATALOG.some((c) => c.name === t) ? 'outline' : 'secondary'} className="font-mono">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2">
            <span className="block text-xs text-zinc-500">maxSteps（config.maxSteps）</span>
            <span className="block text-sm text-zinc-200">
              {(version.config as { maxSteps?: number } | null)?.maxSteps ?? '默认 8'}
            </span>
          </div>
          <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2">
            <span className="block text-xs text-zinc-500">config（原文）</span>
            <span className="block break-all font-mono text-xs text-zinc-300">{configText(version.config)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  const queryClient = useApiQueryClient();
  const { toast } = useToast();
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [draftOpen, setDraftOpen] = useState(false);

  const agent = useQuery<{ data: Agent }, ApiError>({
    queryKey: agentKeys.detail(id),
    queryFn: () => getAgent(id),
    enabled: id !== '',
    retry: apiRetryPolicy,
  });

  const detail: Agent | undefined = agent.data?.data;
  const versions = useMemo(() => detail?.versions ?? [], [detail]);
  const draft = useMemo(() => versions.find((v) => v.status === 'draft') ?? null, [versions]);
  const selected = useMemo(
    () => versions.find((v) => v.id === selectedVersionId) ?? versions[0] ?? null,
    [versions, selectedVersionId],
  );

  // 首次拿到数据时选中「生效版本」，让用户一眼看到线上定义
  useEffect(() => {
    if (selectedVersionId !== '' || versions.length === 0) return;
    setSelectedVersionId(detail?.activeVersionId ?? versions[0].id);
  }, [selectedVersionId, versions, detail?.activeVersionId]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: agentKeys.all });
    void queryClient.invalidateQueries({ queryKey: agentKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: agentKeys.versions(id) });
  };

  const toggleEnabled = useApiMutation((enabled: boolean) => setAgentEnabled(id, enabled), {
    onSuccess: (_res, enabled) => {
      toast({ title: enabled ? '已启用该 Agent' : '已停用该 Agent', variant: 'success' });
      invalidate();
    },
    onError: (err) => toast({ title: '启停失败', description: err.message, variant: 'error' }),
  });

  const publish = useApiMutation(() => publishAgent(id), {
    onSuccess: () => {
      toast({ title: '草稿已上线', description: '旧版本转为归档；历史运行锁定的版本不受影响。', variant: 'success' });
      invalidate();
    },
    onError: (err) => toast({ title: '上线失败', description: err.message, variant: 'error' }),
  });

  const rollback = useApiMutation((versionId: string) => rollbackAgent(id, versionId), {
    onSuccess: () => {
      toast({ title: '已切换生效版本', description: '回滚只改指针，不复制版本，也不影响历史运行。', variant: 'success' });
      invalidate();
    },
    onError: (err) => toast({ title: '切换生效版本失败', description: err.message, variant: 'error' }),
  });

  if (agent.isPending) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-3 px-4 py-8" aria-busy>
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  if (agent.isError || !detail) {
    const forbidden = agent.error?.code === 'FORBIDDEN';
    const notFound = agent.error?.code === 'NOT_FOUND';
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8">
          {forbidden ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Badge variant="warning">需要管理员权限</Badge>
                  <span>无权查看该 Agent</span>
                </CardTitle>
                <CardDescription>
                  Agents 管理接口仅对管理员开放（服务端 RolesGuard 返回 403 FORBIDDEN），当前账号角色不具备该权限。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-zinc-500">服务端返回：{agent.error?.message ?? 'FORBIDDEN'}</span>
                <Button variant="outline" size="sm" onClick={() => void agent.refetch()}>重试</Button>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2">
              <span className="text-sm text-red-300">
                {notFound ? 'Agent 不存在（可能已被移除）' : `Agent 加载失败：${agent.error?.message ?? '未知错误'}`}
              </span>
              <Button variant="outline" size="sm" onClick={() => void agent.refetch()}>重试</Button>
            </div>
          )}
          <p className="mt-4 text-xs text-zinc-500">
            返回 <Link href="/agents" className="text-sky-400 hover:underline">Agents 列表</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
        <div className="flex items-baseline justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold text-zinc-100">{detail.name}</h1>
            <span className="font-mono text-xs text-zinc-500">{detail.slug}</span>
          </div>
          <Link href="/agents" className="text-xs text-sky-400 hover:underline">返回列表</Link>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {detail.enabled ? <Badge variant="success">已启用</Badge> : <Badge variant="secondary">已停用</Badge>}
              <Badge variant="outline">{detail.kind === 'builtin' ? '内置' : detail.kind === 'custom' ? '自定义' : detail.kind}</Badge>
              <Badge variant="outline">{detail.scope === 'system' ? '系统级' : detail.scope === 'organization' ? '组织级' : detail.scope === 'user' ? '用户级' : detail.scope}</Badge>
              {detail.builtin && <Badge variant="secondary">代码内置</Badge>}
            </CardTitle>
            <CardDescription>
              {detail.description ?? '（无描述）'} · 优先级 {detail.priority} · 更新于 {fmtDateTime(detail.updatedAt)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {([
                ['生效版本', detail.activeVersion ? `v${detail.activeVersion.version}` : '无（未上线）'],
                ['草稿版本', draft ? `v${draft.version}` : '无草稿'],
                ['版本总数', String(versions.length)],
              ] as Array<[string, string]>).map(([label, value]) => (
                <div key={label} className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2">
                  <span className="block text-xs text-zinc-500">{label}</span>
                  <span className="block text-sm text-zinc-200">{value}</span>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={toggleEnabled.isPending}
                onClick={() => toggleEnabled.mutate(!detail.enabled)}
              >
                {detail.enabled ? '停用' : '启用'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!draft || publish.isPending}
                title={draft ? `把草稿 v${draft.version} 上线为生效版本` : '没有可上线的草稿（先在下方编辑草稿）'}
                onClick={() => publish.mutate()}
              >
                上线草稿
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={versions.length === 0}
                title="基于当前生效版本或草稿编辑（后端在无草稿时自动复制出 n+1 号草稿）"
                onClick={() => setDraftOpen(true)}
              >
                编辑草稿
              </Button>
              <span className="text-xs text-zinc-500">
                启停不改版本；运行在创建时锁定版本，回滚不影响历史运行。
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>版本</CardTitle>
            <CardDescription>published/archived 不可变——要改定义就编辑草稿再上线</CardDescription>
          </CardHeader>
          <CardContent className="px-0 py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>版本</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>temperature</TableHead>
                  <TableHead>maxTokens</TableHead>
                  <TableHead>工具</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.length === 0 && <TableEmpty colSpan={7}>暂无版本（异常行：Agent 至少应有 v1 草稿）</TableEmpty>}
                {versions.map((v) => {
                  const isActive = v.id === detail.activeVersionId;
                  return (
                    <TableRow key={v.id}>
                      <TableCell>
                        <button
                          type="button"
                          className={`font-mono text-xs hover:underline ${selected?.id === v.id ? 'text-zinc-100' : 'text-sky-400'}`}
                          onClick={() => setSelectedVersionId(v.id)}
                          title="查看该版本详情"
                        >
                          v{v.version}
                        </button>
                        {isActive && <Badge variant="info" className="ml-2">生效中</Badge>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={VERSION_VARIANT[v.status] ?? 'default'}>{VERSION_TEXT[v.status] ?? v.status}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-zinc-400">{v.temperature}</TableCell>
                      <TableCell className="text-xs text-zinc-400">{v.maxTokens ?? '—'}</TableCell>
                      <TableCell className="text-xs text-zinc-400">{toStringArray(v.tools).length}</TableCell>
                      <TableCell className="text-xs text-zinc-400">{fmtDateTime(v.createdAt)}</TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={v.status === 'draft' || isActive || rollback.isPending}
                          title={
                            v.status === 'draft'
                              ? '草稿不能作为回滚目标（后端 400）'
                              : isActive ? '该版本已是生效版本' : '把生效指针指回该版本（不复制版本）'
                          }
                          onClick={() => rollback.mutate(v.id)}
                        >
                          设为生效版本
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {selected && <VersionPanel version={selected} isActive={selected.id === detail.activeVersionId} />}
      </div>

      <AgentDraftDialog
        open={draftOpen}
        onOpenChange={setDraftOpen}
        agentId={id}
        version={draft ?? detail.activeVersion ?? versions[0] ?? null}
        isDraft={draft !== null}
      />
    </div>
  );
}
