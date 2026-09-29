'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { NAV_SECTIONS, isNavItemActive } from '@/lib/navigation';
import { useCurrentUser, useAuthActions } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * 全局左栏导航（M13-F1）
 *
 * 结构约定（**改动前请先读**，这些不是随意选择）：
 *  - 只用 `<aside>/<nav>/<div>/<Link>`，**不出现 `ul > li`**：既有 e2e 用 `ul > li` 判定页面列表行
 *    （readonly-pages.spec.ts 的 workflows/marketplace 断言），导航混入会直接改变其语义；
 *  - **不出现 `<section>` 与标题元素**：evaluation e2e 用「section + 同名 heading」唯一定位分区；
 *  - **不使用 `group` class**：chat e2e 用 `div.group` 定位助手气泡；
 *  - 底部用户区只放「退出登录」一个按钮（避免命中只读页的写操作按钮正则）。
 */
export function GlobalSidebar() {
  const pathname = usePathname();
  const { data: me } = useCurrentUser();
  const { logoutAndRedirect } = useAuthActions();
  const email = me?.data.user.email;
  const displayName = me?.data.user.displayName;

  return (
    <aside aria-label="全局导航栏" className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center gap-2 px-4 py-3">
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md bg-zinc-100 text-xs font-bold text-zinc-900">A</span>
        <span className="truncate text-sm font-semibold text-zinc-100">AI Agent 平台</span>
      </div>

      <nav aria-label="全局导航" className="flex-1 space-y-4 overflow-y-auto px-2 py-2">
        {NAV_SECTIONS.map((section) => (
          <div key={section.id}>
            <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-600">{section.label}</p>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const active = isNavItemActive(item, pathname);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    title={item.hint}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                      active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
                    }`}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-zinc-800 p-2">
        <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
          <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-zinc-800 text-[10px] text-zinc-300">
            {(displayName ?? email ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            {email ? (
              <>
                {displayName ? <span className="block truncate text-xs text-zinc-300">{displayName}</span> : null}
                <span className="block truncate text-[10px] text-zinc-500">{email}</span>
              </>
            ) : (
              <Skeleton className="h-3 w-24" />
            )}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label="退出登录"
            title="退出登录"
            onClick={() => void logoutAndRedirect()}
          >
            <LogOut className="size-3.5" />
          </Button>
        </div>
      </div>
    </aside>
  );
}
