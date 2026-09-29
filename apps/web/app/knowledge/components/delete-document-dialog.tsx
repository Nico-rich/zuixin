'use client';
import { useState } from 'react';
import { ApiError, useApiMutation, useApiQueryClient } from '@/lib/api';
import { deleteDocument, knowledgeKeys, type KnowledgeDocument } from '@/lib/services/knowledge';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * 删除文档确认（M13-W3）
 *
 * 删除是**硬删**（chunks 级联，见后端 KnowledgeRepository）且不可恢复 → 必须二次确认，
 * 确认文案里带上文档名，避免在长列表里删错行。
 */
export function DeleteDocumentDialog({ doc, onOpenChange }: { doc: KnowledgeDocument | null; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const queryClient = useApiQueryClient();
  const [error, setError] = useState<string | null>(null);

  const mutation = useApiMutation((id: string) => deleteDocument(id), {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
      toast({ title: '文档已删除', variant: 'success' });
      setError(null);
      onOpenChange(false);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : '删除失败，请重试'),
  });

  return (
    <Dialog open={doc !== null} onOpenChange={(next) => { if (!next) { setError(null); onOpenChange(false); } }}>
      <DialogHeader>
        <DialogTitle>删除文档</DialogTitle>
        <DialogDescription>删除后文档与其全部分块一并移除，无法恢复。</DialogDescription>
      </DialogHeader>

      <DialogContent className="space-y-3">
        <p className="text-sm text-zinc-300">确认删除「{doc?.name}」？</p>
        {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      </DialogContent>

      <DialogFooter>
        <Button variant="ghost" onClick={() => { setError(null); onOpenChange(false); }} disabled={mutation.isPending}>取消</Button>
        <Button
          variant="destructive"
          disabled={mutation.isPending || !doc}
          onClick={() => { if (doc) { setError(null); mutation.mutate(doc.id); } }}
        >
          {mutation.isPending ? '删除中…' : '删除'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
