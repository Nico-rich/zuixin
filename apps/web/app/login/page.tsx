'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { RETURN_TO_COOKIE, sanitizeReturnTo } from '@/lib/route-guard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * 登录页（M13-F1 修复两处反模式）
 *
 * 修复 1｜**渲染期跳转**：原实现在组件体内直接 `if (me.data) router.replace('/chat')`——
 *   渲染期发起的导航会在每次 re-render 重放（在输入框里打一个字就多跳一次），
 *   现改为 `useEffect`，并用 `navigated` ref 把导航**钉成一次性**：
 *   effect 依赖里的 `router` 身份并不保证稳定（Next 各版本/测试替身都可能每次渲染给新对象），
 *   只靠依赖数组无法保证「只跳一次」，两次导航会让目标页在浏览器历史里堆叠。
 *
 * 修复 2｜**被守卫拦下后回不到原页面**：`middleware.ts` 把原始目标写在 `agent_return_to`
 *   提示 cookie 里（URL 保持裸 `/login`），本页读取后**立即删除**，然后：
 *     · 若带着 returnTo → 先尝试一次**静默续期**（POST /api/v1/auth/refresh）；
 *       成功 → 直接回到目标页（agent_access 只有 15 分钟，而 agent_refresh 有 30 天，
 *       空闲超时后用户不应被要求重新输密码）；
 *       失败 → 落回登录表单（不弹错误：这是正常的过期路径）。
 *   returnTo 值经 sanitizeReturnTo 校验（只允许站内路径，拒绝 //evil.com 之类开放重定向）。
 */
function readCookie(name: string): string | null {
  const hit = document.cookie.split('; ').find((part) => part.startsWith(`${name}=`));
  if (!hit) return null;
  const raw = hit.slice(name.length + 1);
  // middleware 按原样写入（不编码）；这里两种形态都兼容，且不让畸形百分号抛错
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function clearCookie(name: string): void {
  document.cookie = `${name}=; Path=/; Max-Age=0`;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  /** 被守卫重定向过来的目标（null = 直接访问登录页） */
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const bootstrapped = useRef(false);
  /** 自动导航只允许发生一次（静默续期与「已有会话」两条路径共用，避免重复 replace） */
  const navigated = useRef(false);

  const me = useCurrentUser();
  /** 登录成功/已有会话后落地的目标页（默认 /chat） */
  const target = returnTo ?? '/chat';

  // 读取并立即清除 returnTo 提示 cookie（只影响首次挂载）
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    const value = sanitizeReturnTo(readCookie(RETURN_TO_COOKIE));
    clearCookie(RETURN_TO_COOKIE);
    if (value) setReturnTo(value);
  }, []);

  // 静默续期：仅在「被守卫从受保护页重定向过来」时尝试
  useEffect(() => {
    if (!returnTo || navigated.current) return;
    let cancelled = false;
    setResuming(true);
    void (async () => {
      try {
        await apiFetch('/api/v1/auth/refresh', { method: 'POST' });
        if (cancelled) return;
        navigated.current = true;
        router.replace(returnTo);
      } catch {
        if (!cancelled) setResuming(false); // 正常过期路径：落回表单
      }
    })();
    return () => { cancelled = true; };
  }, [returnTo, router]);

  // 已有有效会话（cookie 仍新鲜）→ 直接进入（原渲染期 router.replace 的 useEffect 版本）
  useEffect(() => {
    if (!me.data || navigated.current) return;
    navigated.current = true;
    router.replace(target);
  }, [me.data, target, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await apiFetch('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      router.replace(target);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请稍后再试');
      setLoading(false);
    }
  };

  if (resuming) {
    return <main className="flex min-h-screen items-center justify-center px-4 text-sm text-zinc-500">正在恢复会话…</main>;
  }

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
