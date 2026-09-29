'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useCurrentUser } from '@/lib/auth';

/**
 * 对话路由组的客户端鉴权门（语义**保留**自 M6，M13-F1 起的定位变化见下）。
 *
 * 三层鉴权中的第 1.5 层：
 *  1. `middleware.ts`（服务端）已在发 HTML 前拦下「无会话 cookie」的访问（消除闪加载）；
 *  2. **本文件**：路由组级兜底——/chat 直接渲染要先确认 /auth/me 可用（未登录 → 登录页）；
 *  3. `AppShell`：全站级兜底（会话被吊销/下线 → 登录页）。
 *
 * 与 M6 的差异仅两点（行为等价，去重与共享缓存）：
 *  - 复用 `useCurrentUser()`（与 AppShell 同一 queryKey → 全站只有一次 /auth/me 请求）；
 *  - 容器高度由 `h-screen` 改为 `h-full`（AppShell 已提供 100vh 外壳，避免嵌套出双滚动条）。
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const me = useCurrentUser();
  useEffect(() => {
    if (me.isError) router.replace('/login'); // 未登录 → 登录页
  }, [me.isError, router]);
  if (me.isLoading || me.isError) {
    return <div className="flex h-full items-center justify-center text-zinc-500">加载中…</div>;
  }
  return <>{children}</>;
}
