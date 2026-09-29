import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Select（M13-F1）：**原生 select** 的样式化封装（零依赖、天然可键盘操作、jsdom 可测）。
 *
 * 与既有 ui/input 同尺寸（h-10）+ 同边框/聚焦语言；`aria-label` 由调用方按需要提供
 * （页面若用可见 label，请用 htmlFor/id 关联）。多选/搜索式下拉不在本组件内实现。
 */
const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'flex h-10 w-full appearance-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';

export { Select };
