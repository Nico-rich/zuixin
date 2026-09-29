'use client';
import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** 可选：显示总数（如「共 N 条」）；总数语义由后端分页信封提供 */
  total?: number;
  className?: string;
}

/**
 * Pagination（M13-F1）：服务端分页的通用翻页条（page 从 1 起，与后端分页约定一致）。
 * 翻页是**受控**的：组件不持有状态，避免与 react-query 的 queryKey 脱节。
 */
export function Pagination({ page, totalPages, onPageChange, total, className }: PaginationProps) {
  if (totalPages <= 1) return null;
  return (
    <div className={cn('flex items-center justify-center gap-3 text-xs text-zinc-400', className)}>
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="上一页">
        <ChevronLeft /> 上一页
      </Button>
      <span aria-live="polite">
        {page} / {totalPages}
        {typeof total === 'number' ? `（共 ${total} 条）` : ''}
      </span>
      <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} aria-label="下一页">
        下一页 <ChevronRight />
      </Button>
    </div>
  );
}
