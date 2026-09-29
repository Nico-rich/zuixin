'use client';
import { useState } from 'react';
import { Check, Copy, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from './markdown-renderer';
import { API_BASE } from '@/lib/api';
import { ChatMessage } from './types';

/**
 * M13-W10：本人 user 消息的编辑/删除入口。
 *
 * 授权口径与后端**完全同源**（apps/api/src/modules/chat/chat.controller.ts 的 PATCH/DELETE
 * messages/:id）：仅 `role='user'` 且属于本人的消息可改/可删；assistant 消息只读。
 * 这里只在 user 气泡上渲染入口——服务端仍会独立裁决（越权 → 404 反枚举 / 403 MESSAGE_*_FORBIDDEN）。
 *
 * DOM 约束：user 气泡用 `group/user`（命名 group），**不可**用裸 `group`——既有 e2e 用 `div.group`
 * 定位助手气泡（apps/web/e2e/support/fixtures.ts 的 assistantBubbles）。
 */
export function MessageBubble({ message, streaming, onRetry, onEdit, onDelete, actionsPinned = false }: {
  message: ChatMessage;
  streaming: boolean;
  onRetry: () => void;
  /** 编辑入口（未传 = 只读） */
  onEdit?: () => void;
  /** 删除入口（未传 = 只读） */
  onDelete?: () => void;
  /** 右键唤出操作（true 时操作行常显，不再依赖悬浮） */
  actionsPinned?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';

  const copy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isUser) {
    return (
      <div data-testid="user-bubble" className="group/user flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-zinc-800 px-4 py-2.5 text-[15px] leading-relaxed text-zinc-100">
          {message.content}
        </div>
        {(onEdit || onDelete) && (
          <div
            className={cn(
              'flex items-center gap-1 text-zinc-500 transition-opacity',
              actionsPinned ? 'opacity-100' : 'opacity-0 group-hover/user:opacity-100 group-focus-within/user:opacity-100',
            )}
          >
            {message.editedAt && <span className="mr-1 text-[10px] text-zinc-600">已编辑</span>}
            {onEdit && (
              <button type="button" onClick={onEdit} title="编辑消息" className="rounded p-1 hover:bg-zinc-800 hover:text-zinc-200">
                <Pencil className="size-3.5" />
              </button>
            )}
            {onDelete && (
              <button type="button" onClick={onDelete} title="删除消息" className="rounded p-1 hover:bg-zinc-800 hover:text-red-400">
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="group">
      <div className="flex items-start gap-3">
        <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs text-zinc-300">AI</div>
        <div className={cn('min-w-0 flex-1 pt-1', message.content === '' && streaming && 'text-zinc-500')}>
          {message.content === '' && streaming ? (
            <p className="text-zinc-500">正在生成…</p>
          ) : (
            <MarkdownRenderer content={message.content} />
          )}
          {streaming && <span className="animate-pulse text-zinc-400">▍</span>}
          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {message.attachments.filter((a) => a.type === 'image').map((a) => (
                <a key={a.id} href={`${API_BASE}/api/v1/attachments/${a.id}`} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`${API_BASE}/api/v1/attachments/${a.id}`} alt={a.originalName ?? '图片'} className="max-h-64 w-full rounded-lg border border-zinc-800 object-cover" />
                </a>
              ))}
              {message.attachments.filter((a) => a.type === 'video').map((a) => (
                <div key={a.id} className="col-span-2 rounded-lg border border-zinc-800 bg-zinc-900 sm:col-span-3">
                  <video src={`${API_BASE}/api/v1/attachments/${a.id}`} controls className="max-h-80 w-full" preload="metadata">
                    视频无法播放，<a href={`${API_BASE}/api/v1/attachments/${a.id}`} className="text-blue-400 underline">下载查看</a>
                  </video>
                </div>
              ))}
              {message.attachments.filter((a) => a.type === 'file').map((a) => (
                <a key={a.id} href={`${API_BASE}/api/v1/attachments/${a.id}`} target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
                  📎 {a.originalName ?? '文件'}
                </a>
              ))}
            </div>
          )}
          {message.status === 'failed' && (
            <div className="mt-2 flex items-center gap-3 text-sm text-red-400">
              <span>生成失败{message.errorCode ? `（${message.errorCode}）` : ''}</span>
              <button onClick={onRetry} className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800">
                <RotateCcw className="size-3" /> 重试
              </button>
            </div>
          )}
          {message.status === 'cancelled' && <p className="mt-1 text-xs text-zinc-500">已停止</p>}
        </div>
        {message.content && (
          <button
            onClick={() => void copy()}
            className="mt-1 rounded p-1 text-zinc-500 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-zinc-300 group-hover:opacity-100"
            title="复制"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}
