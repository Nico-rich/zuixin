'use client';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useEffect } from 'react';

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const me = useQuery({ queryKey: ['me'], queryFn: () => apiFetch<{ data: { user: unknown } }>('/api/v1/auth/me') });
  useEffect(() => {
    if (me.isError) router.replace('/login'); // 未登录 → 登录页
  }, [me.isError, router]);
  if (me.isLoading || me.isError) {
    return <div className="flex min-h-screen items-center justify-center text-zinc-500">加载中…</div>;
  }
  return <>{children}</>;
}
