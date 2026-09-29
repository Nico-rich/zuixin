'use client';
import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { WriteError } from '@/components/write-error';
import type { ApiError } from '@/lib/api';

/**
 * ConfirmDialog（M13-W10）：不可逆/破坏性操作的二次确认（删除消息 / 项目 / 工作流）。
 *
 * 为什么抽出来：三处删除的交互与错误呈现完全同构（标题 + 后果说明 + 确认/取消 + 服务端错误如实展示）。
 *
 * 注意：确认按钮文案由调用方给出（如「删除」）——它只在弹窗打开时存在于 DOM，
 * 不影响只读页 e2e 的「无写操作按钮」口径（那些断言在页面初始态取样）。
 */
export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** 确认按钮用 destructive 样式（删除类操作） */
  destructive?: boolean;
  /** 提交中：禁用两个按钮（防重复提交） */
  pending?: boolean;
  error?: ApiError | null;
  /** 403 时的权限说明 */
  forbiddenHint?: string;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel, cancelLabel = '取消',
  destructive = false, pending = false, error = null, forbiddenHint, onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </div>
      </DialogHeader>
      <DialogContent>
        {error ? <WriteError error={error} forbiddenHint={forbiddenHint} /> : null}
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>{cancelLabel}</Button>
        <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} disabled={pending}>
          {pending ? '处理中…' : confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
