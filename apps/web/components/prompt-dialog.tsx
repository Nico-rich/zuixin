'use client';
import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { WriteError } from '@/components/write-error';
import type { ApiError } from '@/lib/api';

/**
 * PromptDialog（M13-W10）：单字段编辑弹窗（项目重命名 / 对话重命名 / 消息内容编辑）。
 *
 * 三处交互同构（一个受控字段 + 提交/取消 + 服务端错误如实展示），抽出来避免三份漂移。
 * 多行场景（消息内容）走 `multiline`——Enter 换行、Ctrl/Cmd+Enter 提交。
 */
export interface PromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  /** 字段标签（与输入控件通过 htmlFor/id 关联） */
  label: string;
  initialValue: string;
  placeholder?: string;
  confirmLabel: string;
  cancelLabel?: string;
  multiline?: boolean;
  rows?: number;
  /** 与服务端上限同源（如消息 20000 / 标题 100）——前端裁剪不代替服务端校验 */
  maxLength?: number;
  pending?: boolean;
  error?: ApiError | null;
  forbiddenHint?: string;
  onSubmit: (value: string) => void;
}

export function PromptDialog({
  open, onOpenChange, title, description, label, initialValue, placeholder,
  confirmLabel, cancelLabel = '取消', multiline = false, rows = 6, maxLength,
  pending = false, error = null, forbiddenHint, onSubmit,
}: PromptDialogProps) {
  const uid = React.useId();
  const [value, setValue] = React.useState(initialValue);

  // 打开（或目标对象切换）时重置为当前值：弹窗关闭时 Dialog 会卸载子树，
  // 但本组件自身常驻 → 不同步会让「上一次编辑的内容」串到下一次。
  React.useEffect(() => { if (open) setValue(initialValue); }, [open, initialValue]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || pending) return;
    onSubmit(trimmed);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (multiline && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <form onSubmit={submit}>
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </div>
        </DialogHeader>
        <DialogContent className="space-y-2">
          <label htmlFor={uid} className="block text-xs text-zinc-400">{label}</label>
          {multiline ? (
            <Textarea
              id={uid}
              value={value}
              rows={rows}
              maxLength={maxLength}
              placeholder={placeholder}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
            />
          ) : (
            <Input
              id={uid}
              value={value}
              maxLength={maxLength}
              placeholder={placeholder}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          {multiline && <p className="text-[11px] text-zinc-600">Enter 换行 · Ctrl/Cmd+Enter 提交</p>}
          <WriteError error={error} forbiddenHint={forbiddenHint} />
        </DialogContent>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>{cancelLabel}</Button>
          <Button type="submit" disabled={pending || !value.trim()}>{pending ? '提交中…' : confirmLabel}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
