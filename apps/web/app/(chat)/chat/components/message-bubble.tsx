'use client';
import { useState } from 'react';
import { Check, Copy, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from './markdown-renderer';
import { API_BASE } from '@/lib/api';
import { ChatMessage } from './types';

export function MessageBubble({ message, streaming, onRetry }: { message: ChatMessage; streaming: boolean; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';

  const copy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-zinc-800 px-4 py-2.5 text-[15px] leading-relaxed text-zinc-100">
          {message.content}
        </div>
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
              {message.attachments.filter((a) => a.type !== 'image').map((a) => (
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
