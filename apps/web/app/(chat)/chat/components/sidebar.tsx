'use client';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ConversationItem } from './types';

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function Sidebar({ activeId, onNew }: { activeId?: string; onNew: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: () => apiFetch<{ data: ConversationItem[] }>('/api/v1/conversations'),
  });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<{ data: { user: { email: string; displayName: string | null } } }>('/api/v1/auth/me'),
  });

  const remove = async (id: string) => {
    try {
      await apiFetch(`/api/v1/conversations/${id}`, { method: 'DELETE' });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (activeId === id) onNew();
    } catch { /* 忽略：列表刷新后自然消失 */ }
  };

  const logout = async () => {
    try { await apiFetch('/api/v1/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
    queryClient.clear();
    router.replace('/login');
  };

  const list = conversations.data?.data ?? [];

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/50">
      <div className="p-3">
        <Button onClick={onNew} className="w-full">
          <Plus /> 新对话
        </Button>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {list.map((c) => (
          <div
            key={c.id}
            onClick={() => router.push(`/chat/${c.id}`)}
            className={`group flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
              activeId === c.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
            }`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{c.title}</span>
              <span className="text-xs text-zinc-500">{formatRelative(c.updatedAt)}</span>
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); void remove(c.id); }}
              className="hidden rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-red-400 group-hover:block"
              title="删除对话"
            >
              <Trash2 className="size-3.5" />
            </button>
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
    </aside>
  );
}
