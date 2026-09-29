'use client';
import { useApiQuery } from '@/lib/api';
import { knowledgeKeys, type KnowledgeDocument } from '@/lib/services/knowledge';
import { Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SkeletonLines } from '@/components/ui/skeleton';
import { formatDateTime } from './format';
import { DocumentStatusBadge, formatBytes, sourceTypeLabel } from './document-status-badge';

/**
 * 文档详情（M13-W3）：**只读**内容预览 + 元数据。
 *
 * 详情单独取 `GET /knowledge/documents/:id`（而非复用列表行）：
 * 列表是 `take 100` 的投影，重建索引后 `chunkCount/status` 会变，详情必须以服务端当前值为准。
 * 内容一律以纯文本渲染（`<pre>`），不解析 Markdown/HTML——文档正文按不可信数据处理。
 */
export function DocumentDetailDialog({ documentId, onOpenChange }: { documentId: string | null; onOpenChange: (open: boolean) => void }) {
  const open = documentId !== null;
  const query = useApiQuery<{ data: KnowledgeDocument }>({
    queryKey: knowledgeKeys.detail(documentId ?? ''),
    path: documentId ? `/api/v1/knowledge/documents/${documentId}` : '',
    enabled: open,
  });
  const doc = query.data?.data;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onOpenChange(false); }}>
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>{doc?.name ?? '文档详情'}</DialogTitle>
          <DialogDescription>
            {doc ? `创建于 ${formatDateTime(doc.createdAt)} · 更新于 ${formatDateTime(doc.updatedAt)}` : '正在读取文档…'}
          </DialogDescription>
        </div>
        <DialogCloseButton onClose={() => onOpenChange(false)} />
      </DialogHeader>

      <DialogContent className="space-y-4">
        {query.isPending && <SkeletonLines lines={6} />}

        {query.isError && (
          <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            <p>文档详情加载失败</p>
            <button type="button" className="mt-2 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-200" onClick={() => void query.refetch()}>
              重试
            </button>
          </div>
        )}

        {doc && (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div className="flex items-center gap-2">
                <dt className="text-zinc-500">来源</dt>
                <dd className="text-zinc-300">{sourceTypeLabel(doc.sourceType)}</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-zinc-500">状态</dt>
                <dd><DocumentStatusBadge status={doc.status} /></dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-zinc-500">分块数</dt>
                <dd className="text-zinc-300">{doc.chunkCount}</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-zinc-500">大小</dt>
                <dd className="text-zinc-300">{formatBytes(doc.sizeBytes)}</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-zinc-500">MIME</dt>
                <dd className="truncate text-zinc-300">{doc.mimeType ?? '—'}</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-zinc-500">版本</dt>
                <dd className="text-zinc-300">v{doc.version}</dd>
              </div>
            </dl>

            {doc.errorCode && (
              <p className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
                上次摄入失败：{doc.errorCode}
              </p>
            )}

            <div>
              <p className="mb-1 text-xs text-zinc-500">内容预览</p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-300">
                {doc.content ?? '（文件源文档的正文存放在对象存储中，重建索引时读取；此处不展示）'}
              </pre>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
