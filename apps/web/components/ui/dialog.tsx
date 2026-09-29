'use client';
import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Dialog（M13-F1）：零依赖手写模态框。
 *
 * 刻意**不用原生 `<dialog showModal>`**：jsdom 未实现 HTMLDialogElement.showModal，
 * 用它会让所有页面单测无法覆盖弹窗分支。这里用 fixed 覆盖层 + 显式状态实现，行为可控且可测：
 *  - role="dialog" aria-modal="true" + aria-labelledby/aria-describedby（由子组件自动挂 id）
 *  - Esc 关闭、点击遮罩关闭（closeOnOverlayClick 可关）、打开时锁定 body 滚动
 *  - 打开时把焦点移入内容区（关闭后归还到打开前的元素）——基础焦点管理，非完整 focus trap
 */
export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** 点遮罩是否关闭（默认 true） */
  closeOnOverlayClick?: boolean;
}

interface DialogIds { titleId: string; descriptionId: string }
const DialogIdsContext = React.createContext<DialogIds | null>(null);

export function Dialog({ open, onOpenChange, children, closeOnOverlayClick = true }: DialogProps) {
  // useId 必须**无条件**在顶层调用：放进 useMemo 工厂里只在首渲跑一次，
  // 二次渲染时 hook 链错位 → React 报 areHookInputsEqual 的 undefined.length（已由组件冒烟测试钉住）
  const uid = React.useId();
  const ids = React.useMemo(() => ({ titleId: `${uid}-title`, descriptionId: `${uid}-desc` }), [uid]);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onOpenChange(false); } };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      restoreFocusRef.current?.focus?.();
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <DialogIdsContext.Provider value={ids}>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          data-testid="dialog-overlay"
          aria-hidden
          onClick={closeOnOverlayClick ? () => onOpenChange(false) : undefined}
          className="absolute inset-0 bg-black/70"
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={ids.titleId}
          aria-describedby={ids.descriptionId}
          tabIndex={-1}
          className="relative z-10 max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl focus-visible:outline-none"
        >
          {children}
        </div>
      </div>
    </DialogIdsContext.Provider>
  );
}

export function DialogHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-start justify-between gap-4 border-b border-zinc-800 px-4 py-3', className)} {...props}>{children}</div>;
}

export function DialogTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  const ids = React.useContext(DialogIdsContext);
  return <h2 id={ids?.titleId} className={cn('text-sm font-semibold text-zinc-100', className)} {...props}>{children}</h2>;
}

export function DialogDescription({ className, children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  const ids = React.useContext(DialogIdsContext);
  return <p id={ids?.descriptionId} className={cn('mt-1 text-xs text-zinc-500', className)} {...props}>{children}</p>;
}

export function DialogContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-3 text-sm text-zinc-300', className)} {...props}>{children}</div>;
}

export function DialogFooter({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3', className)} {...props}>{children}</div>;
}

/** 右上角关闭按钮（调用方自己拿 onOpenChange；也可完全不使用，用 DialogFooter 的取消按钮） */
export function DialogCloseButton({ onClose, className }: { onClose: () => void; className?: string }) {
  return (
    <Button variant="ghost" size="icon" aria-label="关闭" className={cn('shrink-0', className)} onClick={onClose}>
      <X />
    </Button>
  );
}
