'use client';
import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Toast（M13-F1）：零依赖全局轻提示。
 *
 * 用法：`<ToastProvider>` 由 AppShell 全局挂载；页面内 `const { toast } = useToast()`。
 * **无 Provider 时 `useToast()` 返回 no-op**——页面单测可以只渲染页面本身，不必包一层 Provider。
 *
 * 无障碍：容器 aria-live=polite；error 变体用 role="alert"（断言性提示）。
 * 颜色刻意避开 `text-red-400` 字面量——e2e 用 `p.text-red-400` 计数判定「页面错误态」，
 * 提示条不应被计入页面错误横幅。
 */
export type ToastVariant = 'default' | 'success' | 'error';

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** 自动消失毫秒数（<=0 表示不自动消失）；默认 4000 */
  duration?: number;
}

interface ToastItem extends Required<Omit<ToastOptions, 'description'>> { id: string; description?: string }

export interface ToastApi {
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

const NOOP_API: ToastApi = { toast: () => '', dismiss: () => undefined };

/** 取全局 toast API；未挂载 Provider 时返回 no-op（不抛错，保证页面可独立单测） */
export function useToast(): ToastApi {
  return React.useContext(ToastContext) ?? NOOP_API;
}

const VARIANT_STYLE: Record<ToastVariant, string> = {
  default: 'border-zinc-700 bg-zinc-900 text-zinc-200',
  success: 'border-emerald-800 bg-emerald-950/90 text-emerald-200',
  error: 'border-red-900 bg-red-950/90 text-red-200',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = React.useCallback((options: ToastOptions) => {
    const id = `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const duration = options.duration ?? 4000;
    setItems((prev) => [...prev, { id, title: options.title, description: options.description, variant: options.variant ?? 'default', duration }]);
    if (duration > 0) {
      timers.current.set(id, setTimeout(() => {
        timers.current.delete(id);
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, duration));
    }
    return id;
  }, []);

  // 卸载时清空所有计时器（避免测试/路由切换后的悬挂定时器）
  React.useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); timers.current.clear(); }, []);

  const api = React.useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.variant === 'error' ? 'alert' : 'status'}
            data-testid="toast"
            className={cn('pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg', VARIANT_STYLE[t.variant])}
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t.title}</p>
              {t.description && <p className="mt-0.5 text-xs opacity-80">{t.description}</p>}
            </div>
            <button type="button" aria-label="关闭提示" onClick={() => dismiss(t.id)} className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100">
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
