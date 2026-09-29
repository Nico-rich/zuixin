import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Card（M13-F1 组件库）：深色唯一主题下的表面容器。
 * 与既有 button/input/textarea 同体系：手写源码风格（无新依赖），zinc 调色板 + rounded-xl + border。
 */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('rounded-xl border border-zinc-800 bg-zinc-900/40 text-zinc-100', className)} {...props} />
));
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex flex-col gap-1 border-b border-zinc-800/80 px-4 py-3', className)} {...props} />
));
CardHeader.displayName = 'CardHeader';

/** 卡片标题使用 h3：页面 h1/h2 层级不受影响（无障碍层级由使用方决定，此处不强制 asChild） */
const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(({ className, ...props }, ref) => (
  <h3 ref={ref} className={cn('text-sm font-semibold leading-none text-zinc-100', className)} {...props} />
));
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('text-xs text-zinc-500', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('px-4 py-3', className)} {...props} />
));
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex items-center gap-2 border-t border-zinc-800/80 px-4 py-3', className)} {...props} />
));
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
