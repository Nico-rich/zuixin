'use client';
import { useState } from 'react';
import { ApiError, useApiMutation } from '@/lib/api';
import { deleteMemory, type Memory } from '@/lib/services/memories';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * 删除记忆确认（M13-W3）
 *
 * 与「拒绝（status=rejected）」区分开：拒绝只是不再生效、仍可查；删除是**硬删**且不可恢复。
 * 确认区展示记忆正文片段（纯文本）避免删错行。
 */
export function DeleteMemoryDialog({ memory, onClose, onDeleted }: {
  memory: Memory;
  onClose: () => void;
  onDeleted: (memory: Memory) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const mutation = useApiMutation((id: string) => deleteMemory(id), {
    onSuccess: () => onDeleted(memory),
    onError: (e) => setError(e instanceof ApiError ? e.message : '删除失败，请重试'),
  });

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !mutation.isPending) onClose(); }}>
      <DialogHeader>
        <DialogTitle>删除记忆</DialogTitle>
        <DialogDescription>删除后该记忆不再参与上下文组装，且无法恢复（如需保留请改为「已拒绝」）。</DialogDescription>
      </DialogHeader>

      <DialogContent className="space-y-3">
        <p className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-400">{memory.content}</p>
        {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      </DialogContent>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>取消</Button>
        <Button
          variant="destructive"
          disabled={mutation.isPending}
          onClick={() => { setError(null); mutation.mutate(memory.id); }}
        >
          {mutation.isPending ? '删除中…' : '删除'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
