'use client';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * ConfirmDialog（M13-W5）：危险/不可逆操作的统一确认框（删除连接、吊销凭证、移除成员、禁用/删除组织…）。
 *
 * 刻意**不做**「输入名称才能删」之类的强确认——产品的确认口径就是一次显式点击，
 * 且服务端才是裁决方（软删、保留 owner、个人空间不可删等规则一律由后端给出 400/403）。
 *
 * 用法：
 * ```tsx
 * <ConfirmDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}
 *   title="删除连接" description="…" confirmLabel="确认删除" destructive
 *   pending={mutation.isPending} onConfirm={() => mutation.mutate(id)} />
 * ```
 */
export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** 必填：Dialog 的 aria-describedby 指向它（无描述时屏幕阅读器只剩标题，语义不完整） */
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** true = 不可逆/破坏性操作（红色确认按钮） */
  destructive?: boolean;
  /** 请求进行中：两个按钮都禁用，防重复提交 */
  pending?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel, cancelLabel = '取消', destructive = false, pending = false, onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogCloseButton onClose={() => onOpenChange(false)} />
      </DialogHeader>
      <DialogContent>
        <DialogDescription>{description}</DialogDescription>
      </DialogContent>
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
        <Button type="button" variant={destructive ? 'destructive' : 'default'} size="sm" disabled={pending} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
