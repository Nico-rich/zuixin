'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApiQuery, useApiQueryClient } from '@/lib/api';
import {
  listMemories, memoryKeys,
  type ListMemoriesParams, type Memory, type MemoryScope, type MemoryStatus,
} from '@/lib/services/memories';
import { listProjects, projectKeys, type Project } from '@/lib/services/projects';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DeleteMemoryDialog } from './components/delete-memory-dialog';
import { MemoryFormDialog, MEMORY_STATUS_LABEL } from './components/memory-form-dialog';
import { MemoryStatusBadge, SCOPE_LABEL, categoryLabel } from './components/memory-labels';
import { formatDateTime } from './components/format';

/**
 * 记忆（M13-W3）：列表（scope/project/status 过滤 + q 搜索）/ 新建 / 编辑 / 删除。
 *
 * 数据口径：
 *  - 列表 `GET /api/v1/memories`（take 100；importance desc → lastUsedAt desc nulls last → createdAt desc）；
 *  - 服务端**没有** `GET /memories/:id`（契约见 lib/services/memories.ts 头注释）→ 详情一律复用列表行，
 *    因此编辑对话框的初值来自行数据，不做单独的详情请求；
 *  - 新建默认落 `candidate`（**尚未生效**，不进入上下文），提升/降级走 PATCH status（编辑对话框）。
 *
 * 列表查询刻意用 `useQuery` + service 函数而不是 `useApiQuery`：过滤参数会拼成查询串，
 * 而查询串的构造属于 service 层职责（test/services.test.ts 已钉死其编码口径）——页面不应复制一份。
 */
export default function MemoryPage() {
  const { toast } = useToast();
  const queryClient = useApiQueryClient();

  const [scope, setScope] = useState<'all' | MemoryScope>('all');
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState<'' | MemoryStatus>('');
  const [keyword, setKeyword] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');

  const [formTarget, setFormTarget] = useState<{ memory: Memory | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Memory | null>(null);

  const params = useMemo<ListMemoriesParams>(() => {
    const p: ListMemoriesParams = {};
    if (scope !== 'all') p.scope = scope;
    if (projectId) p.projectId = projectId;
    if (status) p.status = status;
    if (appliedQuery) p.q = appliedQuery;
    return p;
  }, [scope, projectId, status, appliedQuery]);

  const list = useQuery({ queryKey: memoryKeys.list(params), queryFn: () => listMemories(params) });
  const memories = list.data?.data ?? [];

  // 项目候选：与聊天侧栏共用 ['projects'] 缓存键（projectKeys.all）
  const projects = useApiQuery<{ data: Project[] }>({ queryKey: projectKeys.all, path: '/api/v1/projects' });
  const projectName = (id: string | null) => (id ? projects.data?.data.find((p) => p.id === id)?.name ?? id : null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: memoryKeys.all });

  const filtered = scope !== 'all' || projectId !== '' || status !== '' || appliedQuery !== '';

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">记忆</h1>
          <p className="mt-1 text-xs text-zinc-500">长期记忆由对话自动提炼为候选，也可手动维护；只有「已生效」的记忆会进入上下文</p>
        </div>
        <Button onClick={() => setFormTarget({ memory: null })}>新建记忆</Button>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div className="w-32">
          <label htmlFor="memory-filter-scope" className="mb-1 block text-xs text-zinc-500">范围</label>
          <Select id="memory-filter-scope" value={scope} onChange={(e) => setScope(e.target.value as 'all' | MemoryScope)}>
            <option value="all">全部范围</option>
            <option value="user">用户级</option>
            <option value="project">项目级</option>
          </Select>
        </div>

        <div className="w-48">
          <label htmlFor="memory-filter-project" className="mb-1 block text-xs text-zinc-500">项目</label>
          <Select id="memory-filter-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">全部项目</option>
            {(projects.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>

        <div className="w-40">
          <label htmlFor="memory-filter-status" className="mb-1 block text-xs text-zinc-500">状态</label>
          <Select id="memory-filter-status" value={status} onChange={(e) => setStatus(e.target.value as '' | MemoryStatus)}>
            <option value="">全部状态</option>
            <option value="candidate">{MEMORY_STATUS_LABEL.candidate}</option>
            <option value="active">{MEMORY_STATUS_LABEL.active}</option>
            <option value="rejected">{MEMORY_STATUS_LABEL.rejected}</option>
          </Select>
        </div>

        <form
          className="flex min-w-0 flex-1 items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); setAppliedQuery(keyword.trim()); }}
        >
          <div className="min-w-0 flex-1">
            <label htmlFor="memory-filter-q" className="mb-1 block text-xs text-zinc-500">关键词</label>
            <Input
              id="memory-filter-q"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="按记忆正文搜索"
            />
          </div>
          <Button type="submit" variant="outline">搜索</Button>
        </form>
      </div>

      {list.isError && (
        <div role="alert" className="mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          <p>记忆列表加载失败</p>
          <p className="mt-1 text-xs text-red-300/80">{list.error.message}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void list.refetch()}>重试</Button>
        </div>
      )}

      {list.isPending ? (
        <div className="space-y-2" aria-busy>
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>内容</TableHead>
              <TableHead className="w-32">范围</TableHead>
              <TableHead className="w-24">分类</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="w-20 text-right">重要度</TableHead>
              <TableHead className="w-40">更新时间</TableHead>
              <TableHead className="w-32 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {memories.length === 0 && !list.isError && (
              <TableEmpty colSpan={7}>
                <span className="block">{filtered ? '没有匹配的记忆' : '还没有记忆'}</span>
                <span className="mt-1 block text-zinc-600">
                  {filtered ? '换个范围/状态或清空关键词再试' : '对话中自动提炼的候选记忆会出现在这里，也可手动新建'}
                </span>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => setFormTarget({ memory: null })}>新建记忆</Button>
              </TableEmpty>
            )}

            {memories.map((m) => (
              <TableRow key={m.id}>
                {/* 记忆正文按不可信数据渲染：纯文本，不解析 Markdown/HTML */}
                <TableCell className="max-w-0">
                  <span className="block truncate text-zinc-200" title={m.content}>{m.content}</span>
                  {m.source && <span className="block truncate text-xs text-zinc-600">来源：{m.source}</span>}
                </TableCell>
                <TableCell className="text-zinc-400">
                  <span className="block">{SCOPE_LABEL[m.scope] ?? m.scope}</span>
                  {m.projectId && <span className="block truncate text-xs text-zinc-600" title={m.projectId}>{projectName(m.projectId)}</span>}
                </TableCell>
                <TableCell className="text-zinc-400">{categoryLabel(m.category)}</TableCell>
                <TableCell><MemoryStatusBadge status={m.status} /></TableCell>
                <TableCell className="text-right text-zinc-400">{m.importance}</TableCell>
                <TableCell className="text-xs text-zinc-500">{formatDateTime(m.updatedAt)}</TableCell>
                <TableCell className="text-right">
                  <span className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setFormTarget({ memory: m })}>编辑</Button>
                    <Button variant="ghost" size="sm" className="text-red-300 hover:text-red-200" onClick={() => setDeleteTarget(m)}>删除</Button>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {formTarget && (
        <MemoryFormDialog
          memory={formTarget.memory}
          projects={projects.data?.data ?? []}
          onClose={() => setFormTarget(null)}
          onSaved={(_saved, mode) => {
            setFormTarget(null);
            void invalidate();
            toast({ title: mode === 'create' ? '记忆已创建' : '记忆已更新', variant: 'success' });
          }}
        />
      )}

      {deleteTarget && (
        <DeleteMemoryDialog
          memory={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={(m) => {
            setDeleteTarget(null);
            void invalidate();
            toast({ title: '记忆已删除', description: m.content.slice(0, 40), variant: 'success' });
          }}
        />
      )}
    </div>
  );
}
