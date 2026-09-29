import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Skeleton（M13-F1）：加载占位。
 * 刻意**不带任何文字**——页面加载态不引入额外文案（避免与既有 e2e 的「加载中…」收敛断言互相干扰）。
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-zinc-800/80', className)} {...props} />;
}

/** 多行文本占位（行数可配） */
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn('h-4', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}
