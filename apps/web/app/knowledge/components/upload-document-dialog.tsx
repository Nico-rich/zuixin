'use client';
import { useRef, useState } from 'react';
import { ApiError, uploadAttachment } from '@/lib/api';
import { createDocument, type KnowledgeDocument } from '@/lib/services/knowledge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

/**
 * 上传文档（M13-W3）
 *
 * 两条摄入路径（与后端 KnowledgeController 的 `sourceType` 一一对应）：
 *  - `text`：直传 content；
 *  - `file`：**先** POST /api/v1/attachments 拿到 attachmentId，**再** POST /knowledge/documents。
 *
 * 文件类型闸门**与后端同口径**（两端都拒绝非文本类文档，前端先拦可省一次无谓往返）：
 *  1. `KnowledgeService.SUPPORTED_TEXT_MIME` = text/plain | text/markdown | text/csv；
 *  2. 附件服务另要求浏览器上报的 MIME 在其白名单内 → 若浏览器给不出类型（Windows 上 .md/.csv 常见），
 *     由扩展名回填规范 MIME，并用**同名新 File** 上传（multipart 分片的 Content-Type 取 File.type，
 *     不改就会以 application/octet-stream 出去而被后端拒）。
 *
 * 摄入是**同步**的（POST 返回时已完成切块+向量化）→ 提交期间必须给出明确的等待反馈。
 */
export const SUPPORTED_DOCUMENT_MIME: readonly string[] = ['text/plain', 'text/markdown', 'text/csv'];

/** 浏览器未上报 MIME 时的扩展名回填表（仅这三类，与后端白名单一致） */
const EXT_MIME: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv' };

export const DOCUMENT_ACCEPT = '.txt,.md,.markdown,.csv,text/plain,text/markdown,text/csv';

/** 后端 file 类型上限（packages/shared LIMITS.FILE_MAX_MB；页面只做提示，真实闸门在服务端） */
export const FILE_MAX_MB = 50;

export interface FileCheck { mime: string | null; error: string | null }

/** 纯函数：判定文件能否作为知识文档摄入（可被单测直接钉住） */
export function checkDocumentFile(file: File): FileCheck {
  const declared = (file.type ?? '').trim().toLowerCase();
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  const inferred = EXT_MIME[ext] ?? null;
  if (declared && !SUPPORTED_DOCUMENT_MIME.includes(declared)) {
    return { mime: null, error: `不支持的文件类型：${declared}（仅支持 .txt / .md / .csv）` };
  }
  const mime = declared || inferred;
  if (!mime) return { mime: null, error: '无法识别文件类型（仅支持 .txt / .md / .csv）' };
  return { mime, error: null };
}

export interface UploadDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 创建成功回调（父级据此提示并失效列表缓存） */
  onCreated: (doc: KnowledgeDocument) => void;
}

type SourceType = 'text' | 'file';

export function UploadDocumentDialog({ open, onOpenChange, onCreated }: UploadDocumentDialogProps) {
  const [sourceType, setSourceType] = useState<SourceType>('text');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setSourceType('text'); setName(''); setContent(''); setFile(null); setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const close = () => { reset(); onOpenChange(false); };

  const submit = async () => {
    if (pending) return;
    const trimmedName = name.trim();
    if (!trimmedName) { setError('请填写文档名称'); return; }

    setError(null);
    setPending(true);
    try {
      let doc: KnowledgeDocument;
      if (sourceType === 'text') {
        if (!content.trim()) { setError('请填写文档内容'); return; }
        const res = await createDocument({ name: trimmedName, sourceType: 'text', content });
        doc = res.data;
      } else {
        if (!file) { setError('请选择文件'); return; }
        const check = checkDocumentFile(file);
        if (!check.mime) { setError(check.error ?? '文件类型不受支持'); return; }
        // 浏览器未上报（或上报为空）时用回填 MIME 重建 File：分片 Content-Type 取 File.type
        const uploadFile = (file.type ?? '').toLowerCase() === check.mime ? file : new File([file], file.name, { type: check.mime });
        const attachment = await uploadAttachment(uploadFile);
        const res = await createDocument({ name: trimmedName, sourceType: 'file', attachmentId: attachment.data.id });
        doc = res.data;
      }
      reset();
      onOpenChange(false);
      onCreated(doc);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '上传失败，请重试');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogHeader>
        <DialogTitle>上传文档</DialogTitle>
        <DialogDescription>文本类文档（.txt / .md / .csv，单文件 ≤ {FILE_MAX_MB}MB），提交后同步完成切块与向量化</DialogDescription>
      </DialogHeader>

      <DialogContent className="space-y-4">
        <div>
          <label htmlFor="kb-doc-name" className="mb-1 block text-xs text-zinc-400">文档名称</label>
          <Input
            id="kb-doc-name"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：产品需求说明"
          />
        </div>

        <Tabs value={sourceType} onValueChange={(v) => { setSourceType(v as SourceType); setError(null); }}>
          <TabsList>
            <TabsTrigger value="text">粘贴文本</TabsTrigger>
            <TabsTrigger value="file">上传文件</TabsTrigger>
          </TabsList>

          <TabsContent value="text" className="pt-3">
            <label htmlFor="kb-doc-content" className="mb-1 block text-xs text-zinc-400">文档内容</label>
            <Textarea
              id="kb-doc-content"
              rows={8}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="粘贴要入库的正文（纯文本）"
            />
          </TabsContent>

          <TabsContent value="file" className="pt-3">
            <label htmlFor="kb-doc-file" className="mb-1 block text-xs text-zinc-400">文档文件</label>
            <input
              id="kb-doc-file"
              ref={fileInputRef}
              type="file"
              accept={DOCUMENT_ACCEPT}
              onChange={(e) => {
                const picked = e.target.files?.[0] ?? null;
                setFile(picked);
                setError(null);
                // 名称为空时用文件名回填（用户仍可改）
                if (picked && !name.trim()) setName(picked.name);
              }}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 file:mr-3 file:rounded file:border-0 file:bg-zinc-800 file:px-2 file:py-1 file:text-xs file:text-zinc-200"
            />
            {file && <p className="mt-1 text-xs text-zinc-500">已选择：{file.name}（{file.type || '类型未知，按扩展名判定'}）</p>}
          </TabsContent>
        </Tabs>

        {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      </DialogContent>

      <DialogFooter>
        <Button variant="ghost" onClick={close} disabled={pending}>取消</Button>
        <Button onClick={() => void submit()} disabled={pending}>{pending ? '处理中…' : '上传'}</Button>
      </DialogFooter>
    </Dialog>
  );
}
