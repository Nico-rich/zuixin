'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Folder, LogOut, Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { apiFetch, jsonInit, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PromptDialog } from '@/components/prompt-dialog';
import { toApiError } from '@/components/write-error';
import { ConversationItem, ProjectItem } from './types';

/**
 * 对话侧栏（会话/项目列表）。
 *
 * M13-W10：补上侧栏写面——项目重命名(PATCH)/删除(DELETE)、对话重命名(PATCH)（悬浮 + 右键菜单）。
 * 授权与语义以服务端为准（apps/api/src/modules/projects|conversations 控制器）：
 *  - 项目写需 project.write（无组织归属的历史个人项目 = 仅本人）；对话写 = 归属本人即可；
 *  - 失败一律如实呈现（403 权限徽标 / 404 反枚举 / 400 校验），绝不静默吞掉。
 *
 * DOM 约束（改动前先读）：本组件渲染在 AppShell 内，**不使用 `ul > li`**（只读页 e2e 用
 * `ul > li` 判定列表行），行容器用 div；命名 group（`group/conv`）而非裸 `group`
 * ——chat e2e 用 `div.group` 定位助手气泡（见 e2e/support/fixtures.ts）。
 */
function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function Sidebar({ activeId }: { activeId?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedProject = searchParams.get('projectId') ?? '';
  const queryClient = useQueryClient();
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creating, setCreating] = useState(false);
  // M13-W10 写面状态
  const [showProjects, setShowProjects] = useState(false);
  const [renamingProject, setRenamingProject] = useState<ProjectItem | null>(null);
  const [deletingProject, setDeletingProject] = useState<ProjectItem | null>(null);
  const [renamingConversation, setRenamingConversation] = useState<ConversationItem | null>(null);
  const [deletingConversation, setDeletingConversation] = useState<ConversationItem | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiFetch<{ data: ProjectItem[] }>('/api/v1/projects'),
  });
  const conversations = useQuery({
    queryKey: ['conversations', selectedProject],
    queryFn: () => apiFetch<{ data: ConversationItem[] }>(`/api/v1/conversations${selectedProject ? `?projectId=${selectedProject}` : ''}`),
  });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<{ data: { user: { email: string; displayName: string | null } } }>('/api/v1/auth/me'),
  });

  const switchProject = (projectId: string) => {
    router.push(projectId ? `/chat?projectId=${projectId}` : '/chat');
  };

  const createProject = async () => {
    const name = newProjectName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const res = await apiFetch<{ data: ProjectItem }>('/api/v1/projects', { method: 'POST', body: JSON.stringify({ name }) });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setShowNewProject(false); setNewProjectName('');
      switchProject(res.data.id);
    } finally {
      setCreating(false);
    }
  };

  const closeActions = () => { setActionError(null); };

  const renameProject = async (name: string) => {
    if (!renamingProject) return;
    setPending(true); setActionError(null);
    try {
      await apiFetch(`/api/v1/projects/${renamingProject.id}`, jsonInit('PATCH', { name }));
      setRenamingProject(null);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
    } catch (err) {
      setActionError(toApiError(err, '重命名失败，请重试'));
    } finally { setPending(false); }
  };

  const removeProject = async () => {
    if (!deletingProject) return;
    setPending(true); setActionError(null);
    try {
      await apiFetch(`/api/v1/projects/${deletingProject.id}`, { method: 'DELETE' });
      const wasSelected = selectedProject === deletingProject.id;
      setDeletingProject(null);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
      // 删的正是当前筛选项目 → 退回「全部对话」（否则会停在已删除项目的空列表里）
      if (wasSelected) switchProject('');
    } catch (err) {
      setActionError(toApiError(err, '删除失败，请重试'));
    } finally { setPending(false); }
  };

  const renameConversation = async (title: string) => {
    if (!renamingConversation) return;
    setPending(true); setActionError(null);
    try {
      await apiFetch(`/api/v1/conversations/${renamingConversation.id}`, jsonInit('PATCH', { title }));
      setRenamingConversation(null);
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch (err) {
      setActionError(toApiError(err, '重命名失败，请重试'));
    } finally { setPending(false); }
  };

  const remove = async () => {
    if (!deletingConversation) return;
    setPending(true); setActionError(null);
    try {
      await apiFetch(`/api/v1/conversations/${deletingConversation.id}`, { method: 'DELETE' });
      const target = deletingConversation.id;
      setDeletingConversation(null);
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (activeId === target) router.push(selectedProject ? `/chat?projectId=${selectedProject}` : '/chat');
    } catch (err) {
      setActionError(toApiError(err, '删除失败，请重试'));
    } finally { setPending(false); }
  };

  const logout = async () => {
    try { await apiFetch('/api/v1/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
    queryClient.clear();
    router.replace('/login');
  };

  const list = conversations.data?.data ?? [];
  const projectList = projects.data?.data ?? [];

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/50">
      <div className="space-y-2 p-3">
        {/* Project 选择器 */}
        <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900">
          <Folder className="ml-2 size-4 shrink-0 text-zinc-500" />
          <select
            value={selectedProject}
            onChange={(e) => switchProject(e.target.value)}
            className="h-9 flex-1 bg-transparent text-sm text-zinc-200 focus:outline-none"
          >
            <option value="">全部对话</option>
            {projectList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={() => setShowNewProject((v) => !v)} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="新建项目">
            <Plus className="size-3.5" />
          </button>
          <button
            onClick={() => { closeActions(); setShowProjects((v) => !v); }}
            className={`mr-1 rounded p-1 hover:bg-zinc-800 hover:text-zinc-200 ${showProjects ? 'text-zinc-200' : 'text-zinc-500'}`}
            title="管理项目（重命名/删除）"
            aria-expanded={showProjects}
          >
            <Tags className="size-3.5" />
          </button>
        </div>
        {showNewProject && (
          <div className="flex gap-1">
            <Input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="项目名称" className="h-8 text-xs" autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') void createProject(); }} />
            <Button size="sm" className="h-8" onClick={() => void createProject()} disabled={creating || !newProjectName.trim()}>创建</Button>
          </div>
        )}

        {/* 项目管理（重命名 / 删除）：只在展开时占位，避免列表常态噪声 */}
        {showProjects && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
            {projectList.length === 0 && <p className="px-2 py-1.5 text-xs text-zinc-600">还没有项目</p>}
            {projectList.map((p) => (
              <div key={p.id} className={`group/proj flex items-center gap-1 rounded px-2 py-1 text-xs ${selectedProject === p.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'}`}>
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <button
                  onClick={() => { closeActions(); setRenamingProject(p); }}
                  className="rounded p-1 text-zinc-500 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-zinc-200 group-hover/proj:opacity-100 focus-visible:opacity-100"
                  title="重命名项目"
                >
                  <Pencil className="size-3" />
                </button>
                <button
                  onClick={() => { closeActions(); setDeletingProject(p); }}
                  className="rounded p-1 text-zinc-500 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-red-400 group-hover/proj:opacity-100 focus-visible:opacity-100"
                  title="删除项目"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <Button onClick={() => router.push(selectedProject ? `/chat?projectId=${selectedProject}` : '/chat')} className="w-full" variant="outline">
          <Plus /> 新对话
        </Button>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {list.map((c) => (
          <div
            key={c.id}
            onClick={() => router.push(`/chat/${c.id}${selectedProject ? `?projectId=${selectedProject}` : ''}`)}
            className={`group/conv flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
              activeId === c.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
            }`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{c.title}</span>
              <span className="text-xs text-zinc-500">{formatRelative(c.updatedAt)}</span>
            </span>
            <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/conv:opacity-100 group-focus-within/conv:opacity-100">
              <button
                onClick={(e) => { e.stopPropagation(); closeActions(); setRenamingConversation(c); }}
                className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
                title="重命名对话"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); closeActions(); setDeletingConversation(c); }}
                className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-red-400"
                title="删除对话"
              >
                <Trash2 className="size-3.5" />
              </button>
            </span>
          </div>
        ))}
        {list.length === 0 && <p className="px-3 py-6 text-center text-xs text-zinc-600">还没有对话，点击上方开始</p>}
      </nav>
      <div className="border-t border-zinc-800 p-3">
        <div className="flex items-center justify-between">
          <span className="truncate text-xs text-zinc-400">{me.data?.data.user.displayName ?? me.data?.data.user.email ?? ''}</span>
          <Button variant="ghost" size="sm" onClick={() => void logout()} title="退出登录">
            <LogOut className="size-3.5" /> 退出
          </Button>
        </div>
      </div>

      <PromptDialog
        open={renamingProject !== null}
        onOpenChange={(open) => { if (!open) { setRenamingProject(null); closeActions(); } }}
        title="重命名项目"
        label="项目名称"
        initialValue={renamingProject?.name ?? ''}
        confirmLabel="保存"
        maxLength={100}
        pending={pending}
        error={actionError}
        forbiddenHint="需要 project.write 权限"
        onSubmit={(value) => void renameProject(value)}
      />
      <ConfirmDialog
        open={deletingProject !== null}
        onOpenChange={(open) => { if (!open) { setDeletingProject(null); closeActions(); } }}
        title="删除项目"
        description={`将删除「${deletingProject?.name ?? ''}」；项目下的对话不会被删除，但不再出现在该项目分组中。`}
        confirmLabel="删除"
        destructive
        pending={pending}
        error={actionError}
        forbiddenHint="需要 project.write 权限"
        onConfirm={() => void removeProject()}
      />
      <PromptDialog
        open={renamingConversation !== null}
        onOpenChange={(open) => { if (!open) { setRenamingConversation(null); closeActions(); } }}
        title="重命名对话"
        label="对话标题"
        initialValue={renamingConversation?.title ?? ''}
        confirmLabel="保存"
        maxLength={100}
        pending={pending}
        error={actionError}
        onSubmit={(value) => void renameConversation(value)}
      />
      <ConfirmDialog
        open={deletingConversation !== null}
        onOpenChange={(open) => { if (!open) { setDeletingConversation(null); closeActions(); } }}
        title="删除对话"
        description={`将删除「${deletingConversation?.title ?? ''}」（服务端软删除，删除后不再出现在列表中）。`}
        confirmLabel="删除"
        destructive
        pending={pending}
        error={actionError}
        onConfirm={() => void remove()}
      />
    </aside>
  );
}
