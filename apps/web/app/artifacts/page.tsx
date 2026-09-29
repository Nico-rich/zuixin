'use client';

import { useState } from 'react';
import { Download, FileText, Info } from 'lucide-react';
import { useApiQuery } from '@/lib/api';
import {
  ARTIFACT_TYPES, ArtifactDetail, ArtifactListItem, ArtifactType, artifactDownloadPath, artifactKeys,
} from '@/lib/services/artifacts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { SkeletonLines } from '@/components/ui/skeleton';

/**
 * /artifacts —— 制品库（M13-W9 闭环断裂修复之二）
 *
 * 此前 Artifacts **只有 service、没有 HTTP 面** → 制品在 Web 上完全不可见（Agent 生成的
 * 图像/报告/简报/分析没有任何落地页）。本页是只读展示面：
 *  - **只读**：页面不含任何"新建/编辑/删除制品"入口——制品的唯一写路径是 Agent 工具
 *    （`artifact.create`，经 ToolCall 幂等账本落库）。"工具即接口"，UI 不提供第二条写路径；
 *  - **投影**：服务端不下发 `storageKey` / `idempotencyKey`，页面也拿不到；
 *  - **UNTRUSTED 字节**：制品内容可能来自 LLM / 外部工具。文件只在用户点击时经
 *    **同源代理端点**（`/api/v1/artifacts/:id/download`，服务端做归属校验 + `attachment` 强制下载）
 *    取回；`content` 里的外部 URL 只作为文本链接展示，**绝不自动内联加载**（避免被用来做探测）。
 */

const TYPE_LABEL: Record<ArtifactType, string> = {
  creative_brief: '创意简报',
  image: '图片',
  video: '视频',
  report: '报告',
  analysis: '分析',
  other: '其他',
};

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  ready: 'success',
  draft: 'warning',
  failed: 'destructive',
};

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** 从 `content` 里取第一个字符串型链接字段（**只用于展示为链接**，不自动加载） */
function externalUrlOf(content: unknown): string | null {
  const record = asRecord(content);
  if (!record) return null;
  for (const key of ['url', 'imageUrl', 'videoUrl', 'href']) {
    const v = record[key];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  }
  return null;
}

/** 报告/文本适配：markdown 优先，其次 text/body */
function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  const record = asRecord(content);
  if (!record) return null;
  for (const key of ['markdown', 'text', 'body', 'content']) {
    const v = record[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

export default function ArtifactsPage() {
  const [type, setType] = useState<ArtifactType | 'all'>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useApiQuery<{ data: ArtifactListItem[] }>({
    queryKey: artifactKeys.list(type),
    path: `/api/v1/artifacts${type === 'all' ? '' : `?type=${type}`}`,
  });

  const detail = useApiQuery<{ data: ArtifactDetail }>({
    queryKey: artifactKeys.detail(openId ?? ''),
    path: `/api/v1/artifacts/${encodeURIComponent(openId ?? '')}`,
    enabled: openId !== null,
  });

  const items = query.data?.data ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-zinc-100">制品库</h1>
        <span className="text-xs text-zinc-500">
          只读展示 · 写入由 Agent 工具执行（工具即接口）· 字节按不可信内容处理
        </span>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <label htmlFor="artifact-type" className="text-xs text-zinc-500">类型</label>
        <Select
          id="artifact-type"
          aria-label="制品类型"
          className="h-9 w-40"
          value={type}
          onChange={(e) => setType(e.target.value as ArtifactType | 'all')}
        >
          <option value="all">全部</option>
          {ARTIFACT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </Select>
      </div>

      {query.isPending && <SkeletonLines lines={4} />}
      {query.isError && <p className="p-4 text-sm text-red-400">制品列表加载失败：{query.error.message}</p>}
      {!query.isPending && !query.isError && items.length === 0 && (
        <p className="py-12 text-center text-sm text-zinc-500">还没有该类型的制品</p>
      )}

      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <Card data-testid={`artifact-${item.id}`}>
              <CardHeader className="flex-row items-center justify-between gap-3">
                <CardTitle className="min-w-0 flex-1 truncate" title={item.title}>{item.title}</CardTitle>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge variant="info">{TYPE_LABEL[item.type] ?? item.type}</Badge>
                  <Badge variant={STATUS_VARIANT[item.status] ?? 'secondary'}>{item.status}</Badge>
                </span>
              </CardHeader>
              <CardContent className="space-y-2">
                {item.summary && <p className="text-sm text-zinc-400">{item.summary}</p>}
                <p className="text-xs text-zinc-500">
                  创建于 {fmt(item.createdAt)}
                  {item.runId ? ` · 运行 ${item.runId}` : ''}
                </p>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setOpenId(item.id)}>查看详情</Button>
                  {item.downloadUrl && (
                    <a
                      href={artifactDownloadPath(item.id)}
                      className="inline-flex items-center gap-1 text-xs text-zinc-300 underline-offset-2 hover:underline"
                    >
                      <Download className="size-3.5" aria-hidden />下载文件
                    </a>
                  )}
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      <Dialog open={openId !== null} onOpenChange={(open) => { if (!open) setOpenId(null); }}>
        <DialogHeader>
          <DialogTitle>{detail.data?.data.title ?? '制品详情'}</DialogTitle>
          <DialogDescription>
            类型 {detail.data?.data.type ? TYPE_LABEL[detail.data.data.type as ArtifactType] ?? detail.data.data.type : '—'}
            {' · '}创建于 {fmt(detail.data?.data.createdAt)}
          </DialogDescription>
        </DialogHeader>
        <DialogContent>
          {detail.isPending && <SkeletonLines lines={3} />}
          {detail.isError && <p className="text-sm text-red-400">详情加载失败：{detail.error.message}</p>}
          {detail.data && <ArtifactPreview artifact={detail.data.data} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 详情预览：按类型适配（图片 / 文本报告 / 分析 / 其他） */
function ArtifactPreview({ artifact }: { artifact: ArtifactDetail }) {
  const text = textOf(artifact.content);
  const record = asRecord(artifact.content);
  const url = externalUrlOf(artifact.content);

  return (
    <div className="space-y-3">
      {artifact.summary && <p className="text-sm text-zinc-300">{artifact.summary}</p>}

      {/* 图片：优先走**同源代理**（服务端归属校验 + 强制下载头），不直接加载 UNTRUSTED 外链 */}
      {artifact.type === 'image' && (
        artifact.downloadUrl ? (
          <img
            src={artifactDownloadPath(artifact.id)}
            alt={artifact.title}
            className="max-h-80 w-full rounded-lg border border-zinc-800 object-contain"
          />
        ) : (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-500">
            该图片制品没有落库文件（仅结构化内容）。
          </p>
        )
      )}

      {artifact.type === 'video' && (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-500">
          视频字节不在此内联播放（UNTRUSTED 内容只经代理下载端点取回）。
        </p>
      )}

      {/* 报告 / 文本：预格式文本（React 转义，绝不用 dangerouslySetInnerHTML） */}
      {text && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
          <p className="mb-1 flex items-center gap-1 text-xs text-zinc-500">
            <FileText className="size-3.5" aria-hidden />正文（原文呈现，未渲染为 HTML）
          </p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-200">{text}</pre>
        </div>
      )}

      {artifact.type === 'analysis' && record && (
        <p className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-500">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>facts / derived / anomalies = 服务端计算；possibleCauses / recommendations = LLM 推测，两者分层标注，不得混同。</span>
        </p>
      )}

      {/* 结构化内容原文（JSON）：分析/简报/其他类型的兜底视图 */}
      {artifact.content !== null && artifact.content !== undefined && !text && (
        <pre className="max-h-72 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-300">
          {JSON.stringify(artifact.content, null, 2)}
        </pre>
      )}

      {url && (
        <p className="break-all text-xs text-zinc-500">
          内容含外部链接：<a className="text-zinc-300 underline-offset-2 hover:underline" href={url} target="_blank" rel="noreferrer noopener">{url}</a>
          （仅展示为链接，页面不自动加载外部资源）
        </p>
      )}

      <div className="flex items-center gap-2">
        {artifact.downloadUrl ? (
          <a
            href={artifactDownloadPath(artifact.id)}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            <Download className="size-3.5" aria-hidden />下载文件
          </a>
        ) : (
          <span className="text-xs text-zinc-500">该制品无关联文件（纯结构化内容）</span>
        )}
      </div>
    </div>
  );
}
