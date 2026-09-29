'use client';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Tabs（M13-F1）：受控/非受控两用，零依赖手写实现。
 *
 * 无障碍：role=tablist/tab/tabpanel + aria-selected/aria-controls；← → Home End 键盘导航
 * （roving tabindex）。面板用 hidden 属性切换**而非卸载**——避免切页签丢失已填表单，
 * 同时保证测试里 queryByRole('tabpanel', {hidden:false}) 语义正确。
 */
interface TabsContextValue {
  value: string;
  setValue: (v: string) => void;
  baseId: string;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error(`<${component}> 必须放在 <Tabs> 内使用`);
  return ctx;
}

export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}

export function Tabs({ value, defaultValue, onValueChange, className, children }: TabsProps) {
  const [internal, setInternal] = React.useState(defaultValue ?? '');
  const current = value ?? internal;
  const baseId = React.useId();
  const setValue = React.useCallback((next: string) => {
    setInternal(next);
    onValueChange?.(next);
  }, [onValueChange]);
  const ctx = React.useMemo(() => ({ value: current, setValue, baseId }), [current, setValue, baseId]);
  return <TabsContext.Provider value={ctx}><div className={className}>{children}</div></TabsContext.Provider>;
}

export function TabsList({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { baseId } = useTabsContext('TabsList');
  const ref = React.useRef<HTMLDivElement>(null);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const tabs = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])') ?? []);
    if (tabs.length === 0) return;
    const idx = tabs.findIndex((t) => t === document.activeElement);
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? tabs.length - 1
        : e.key === 'ArrowLeft' ? (idx - 1 + tabs.length) % tabs.length
          : (idx + 1) % tabs.length;
    e.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  };

  return (
    <div
      ref={ref}
      role="tablist"
      id={`${baseId}-list`}
      onKeyDown={onKeyDown}
      className={cn('flex items-center gap-1 border-b border-zinc-800', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export function TabsTrigger({ value, className, children, ...props }: TabsTriggerProps) {
  const { value: current, setValue, baseId } = useTabsContext('TabsTrigger');
  const active = current === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-selected={active}
      aria-controls={`${baseId}-panel-${value}`}
      tabIndex={active ? 0 : -1}
      onClick={() => setValue(value)}
      className={cn(
        '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-zinc-400 transition-colors hover:text-zinc-200',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500',
        active && 'border-zinc-300 text-zinc-100',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({ value, className, children, ...props }: TabsContentProps) {
  const { value: current, baseId } = useTabsContext('TabsContent');
  const active = current === value;
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      hidden={!active}
      className={cn('pt-4 focus-visible:outline-none', className)}
      tabIndex={0}
      {...props}
    >
      {children}
    </div>
  );
}
