'use client';
import { useState } from 'react';
import { ApiError, useApiMutation, useApiQuery, useApiQueryClient } from '@/lib/api';
import { knowledgeKeys, reindexDocument, type KnowledgeDocument } from '@/lib/services/knowledge';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DeleteDocumentDialog } from './components/delete-document-dialog';
import { DocumentDetailDialog } from './components/document-detail-dialog';
import { DocumentStatusBadge, sourceTypeLabel } from './components/document-status-badge';
import { UploadDocumentDialog } from './components/upload-document-dialog';
import { formatDateTime } from './components/format';

/**
 * 知识库（M13-W3）：列表 / 上传 / 详情预览 / 重建索引 / 删除。
 *
 * 数据口径：
 *  - 列表 `GET /api/v1/knowledge/documents`（take 100、createdAt desc，**无分页**，服务端裁定）；
 *  - 摄入**同步**完成（返回即已切块+向量化）→ 上传对话框在提交期间给出明确等待反馈；
 *  - 一切写操作后只失效 `knowledgeKeys.all`（含详情），不手改本地缓存（服务端是唯一事实源）。
 *
 * 本页**不提供检索/问答入口**：知识检索是 Agent 运行期能力（tool），不在管理面暴露第二套查询语义。
 */
export default function KnowledgePage() {
  const { toast } = useToast();
  const queryClient = useApiQueryClient();

  const [uploadOpen, setUploadOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeDocument | null>(null);

  const list = useApiQuery<{ data: KnowledgeDocument[] }>({
    // 路径与 lib/services/knowledge.listDocuments() 同源（静态路径，无查询串）
    queryKey: knowledgeKeys.list(),
    path: '/api/v1/knowledge/documents',
  });
  const documents = list.data?.data ?? [];

  const reindex = useApiMutation((id: string) => reindexDocument(id), {
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
      toast({ title: '已重建索引', description: `${res.data.name} · ${res.data.chunkCount} 个分块`, variant: 'success' });
    },
    onError: (e) => toast({ title: '重建索引失败', description: e instanceof ApiError ? e.message : undefined, variant: 'error' }),
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">知识库</h1>
          <p className="mt-1 text-xs text-zinc-500">文本类文档入库后自动切块与向量化，供 Agent 检索使用</p>
        </div>
        <Button onClick={() => setUploadOpen(true)}>上传文档</Button>
      </div>

      {list.isError && (
        <div role="alert" className="mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          <p>知识库文档加载失败</p>
          <p className="mt-1 text-xs text-red-300/80">{list.error.message}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void list.refetch()}>重试</Button>
        </div>
      )}

      {list.isPending ? (
        <div className="space-y-2" aria-busy>
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>文档名</TableHead>
              <TableHead className="w-20">类型</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="w-40">创建时间</TableHead>
              <TableHead className="w-56 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.length === 0 && !list.isError && (
              <TableEmpty colSpan={5}>
                <span className="block">知识库还没有文档</span>
                <span className="mt-1 block text-zinc-600">上传 .txt / .md / .csv 文本类文档（单文件 ≤ 50MB）即可开始</span>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => setUploadOpen(true)}>上传第一份文档</Button>
              </TableEmpty>
            )}

            {documents.map((doc) => (
              <TableRow key={doc.id}>
                <TableCell className="max-w-0">
                  <span className="block truncate font-medium text-zinc-200" title={doc.name}>{doc.name}</span>
                  {doc.errorCode && <span className="block truncate text-xs text-amber-400">摄入失败：{doc.errorCode}</span>}
                </TableCell>
                <TableCell className="text-zinc-400">{sourceTypeLabel(doc.sourceType)}</TableCell>
                <TableCell><DocumentStatusBadge status={doc.status} /></TableCell>
                <TableCell className="text-xs text-zinc-500">{formatDateTime(doc.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <span className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setDetailId(doc.id)}>查看</Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={reindex.isPending}
                      onClick={() => reindex.mutate(doc.id)}
                    >
                      {reindex.isPending && reindex.variables === doc.id ? '重建中…' : '重建索引'}
                    </Button>
                    <Button variant="ghost" size="sm" className="text-red-300 hover:text-red-200" onClick={() => setDeleteTarget(doc)}>删除</Button>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <UploadDocumentDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onCreated={(doc) => {
          void queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
          toast({ title: '文档已入库', description: `${doc.name} · ${doc.chunkCount} 个分块`, variant: 'success' });
        }}
      />
      <DocumentDetailDialog documentId={detailId} onOpenChange={(open) => { if (!open) setDetailId(null); }} />
      <DeleteDocumentDialog doc={deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }} />
    </div>
  );
}
