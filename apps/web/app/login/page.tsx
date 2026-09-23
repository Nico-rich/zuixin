'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const me = useQuery({ queryKey: ['me'], queryFn: () => apiFetch<{ data: { user: unknown } }>('/api/v1/auth/me') });
  if (me.data) router.replace('/chat'); // 已登录直接进入

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await apiFetch('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      router.replace('/chat');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请稍后再试');
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5">
        <div className="text-center">
          <h1 className="text-2xl font-bold">AI Agent 智能创作平台</h1>
          <p className="mt-2 text-sm text-zinc-400">登录以开始与 AI 对话</p>
        </div>
        <Input type="email" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <Input type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button type="submit" disabled={loading} className="w-full">{loading ? '登录中…' : '登录'}</Button>
      </form>
    </main>
  );
}
