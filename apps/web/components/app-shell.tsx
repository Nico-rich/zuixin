'use client';
import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { GlobalSidebar } from '@/components/global-sidebar';
import { ToastProvider } from '@/components/ui/toast';
import { isSessionExpired, useCurrentUser } from '@/lib/auth';
import { isPublicPath } from '@/lib/route-guard';

/**
 * AppShell（M13-F1）：全站唯一外壳。
 *
 * 挂在 `app/layout.tsx`（根布局）而非某个路由组 → **W2~W9 新增的每个页面自动获得全局导航**，
 * 页面 agents 不需要改任何布局文件（导航入口见 lib/navigation.ts）。
 *
 * 鉴权分层（三层，各司其职）：
 *  1. `middleware.ts`（服务端）：无 agent_access cookie → 在发 HTML 前 302 到 /login（消除闪加载）；
 *  2. 本组件（客户端兜底）：cookie 在但**会话已失效**（被吊销/被下线）→ 跳 /login。
 *     （客户端唯一能拿到「会话是否真的有效」结论的地方：/auth/me 是 auth 端点，不会自动续期重试）
 *  3. 公开路由（/login）不渲染外壳，也不发 /auth/me（避免登录页出现无谓 401）。
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const publicRoute = isPublicPath(pathname);
  const me = useCurrentUser({ enabled: !publicRoute });

  useEffect(() => {
    if (!publicRoute && me.isError && isSessionExpired(me.error)) router.replace('/login');
  }, [publicRoute, me.isError, me.error, router]);

  // 公开路由（登录页等）：不渲染导航外壳（登录页有自己的全屏居中布局）
  if (publicRoute) return <ToastProvider>{children}</ToastProvider>;

  return (
    <ToastProvider>
      <div className="flex h-screen overflow-hidden">
        <GlobalSidebar />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </ToastProvider>
  );
}
