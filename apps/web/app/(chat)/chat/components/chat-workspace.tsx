'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, API_BASE } from '@/lib/api';
import { consumeSSE } from '@/lib/sse';
import { Sidebar } from './sidebar';
import { ChatInput } from './chat-input';
import { MessageBubble } from './message-bubble';
import { TaskCard } from './task-card';
import { RunTimeline } from './run-timeline';
import { ActiveTask, AttachmentView, ChatMessage, ChatStreamEventMap } from './types';

interface HistoryMessage {
  id: string; role: 'user' | 'assistant'; content: string; status: string; errorCode: string | null;
  intentType: string | null; createdAt: string;
  attachments: Array<{ id: string; kind: AttachmentView['kind']; type: AttachmentView['type']; mimeType: string; originalName: string | null }>;
}

export function ChatWorkspace({ conversationId }: { conversationId?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get('projectId') ?? undefined;
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<ActiveTask[]>([]);
  const [thinking, setThinking] = useState('');
  const [currentTool, setCurrentTool] = useState('');
  const [runIds, setRunIds] = useState<Record<string, string>>({});
  const [streaming, setStreaming] = useState(false);
  const [fatalError, setFatalError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const deltaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deltaBuf = useRef('');
  const assistantIdRef = useRef<string | null>(null);
  const activeIdRef = useRef<string | undefined>(conversationId);

  // 历史消息加载（含附件）
  const history = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: async () => {
      if (!conversationId) return [];
      const res = await apiFetch<{ data: HistoryMessage[] }>(`/api/v1/conversations/${conversationId}/messages`);
      return res.data.map((m) => ({ ...m, status: m.status as ChatMessage['status'] }));
    },
    enabled: !!conversationId,
  });

  useEffect(() => {
    setMessages(history.data ?? []);
    setThinking(''); setFatalError(''); setTasks([]);
  }, [history.data]);

  const flushDelta = useCallback((targetId: string) => {
    const delta = deltaBuf.current;
    deltaBuf.current = '';
    if (!delta) return;
    setMessages((prev) => prev.map((m) => (m.id === targetId ? { ...m, content: m.content + delta } : m)));
  }, []);

  const appendDelta = useCallback((messageId: string, delta: string) => {
    deltaBuf.current += delta;
    if (deltaTimer.current) clearTimeout(deltaTimer.current);
    deltaTimer.current = setTimeout(() => flushDelta(messageId), 40); // 40ms 节流合并渲染
  }, [flushDelta]);

  const send = useCallback(async (text: string, attachmentIds: string[]) => {
    if (streaming || !text.trim()) return;
    setFatalError('');
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: 'user', content: text, status: 'completed' }]);
    setStreaming(true); setThinking('正在分析需求…');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(`${API_BASE}/api/v1/chat`, {
        method: 'POST', credentials: 'include', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ conversationId: activeIdRef.current ?? null, projectId: projectId ?? null, attachmentIds, message: text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(body?.error?.code ?? 'INTERNAL', body?.error?.message ?? '生成失败');
      }
      await consumeSSE(res.body!, (event, raw) => {
        let data: ChatStreamEventMap[keyof ChatStreamEventMap] | null = null;
        try { data = JSON.parse(raw); } catch { return; }
        switch (event) {
          case 'run.created': {
            const r = data as ChatStreamEventMap['run_created'];
            if (assistantIdRef.current) {
              setRunIds((prev) => ({ ...prev, [assistantIdRef.current!]: r.runId }));
            }
            break;
          }
          case 'message_start': {
            const d = data as ChatStreamEventMap['message_start'];
            assistantIdRef.current = d.messageId;
            if (!activeIdRef.current) {
              activeIdRef.current = d.conversationId;
              router.replace(`/chat/${d.conversationId}${projectId ? `?projectId=${projectId}` : ''}`, { scroll: false });
              queryClient.invalidateQueries({ queryKey: ['conversations'] });
            }
            setMessages((prev) => prev.some((m) => m.id === d.messageId) ? prev
              : [...prev, { id: d.messageId, role: 'assistant', content: '', status: 'streaming' }]);
            break;
          }
          case 'message_delta': {
            const d = data as ChatStreamEventMap['message_delta'];
            if (assistantIdRef.current) appendDelta(assistantIdRef.current, d.delta);
            break;
          }
          case 'status': { setThinking((data as ChatStreamEventMap['status']).message); break; }
          case 'tool.start': {
            const t = data as ChatStreamEventMap['tool_start'];
            setCurrentTool(t.toolName);
            setThinking(`正在调用 ${t.toolName}…`);
            break;
          }
          case 'tool.end': {
            const te = data as ChatStreamEventMap['tool_end'];
            setCurrentTool('');
            setThinking(te.outputSummary ?? '工具执行完成');
            break;
          }
          case 'task.created': {
            const d = data as ChatStreamEventMap['task_created'];
            setTasks((prev) => [...prev, { taskId: d.taskId, kind: d.kind }]);
            break;
          }
          case 'message_end': {
            const d = data as ChatStreamEventMap['message_end'];
            flushDelta(d.messageId);
            const status = d.status === 'stopped' ? 'cancelled' : d.status;
            setMessages((prev) => prev.map((m) => (m.id === d.messageId ? { ...m, status } : m)));
            setThinking('');
            break;
          }
          case 'error': {
            const d = data as ChatStreamEventMap['error'];
            setFatalError(d.message);
            if (assistantIdRef.current) {
              setMessages((prev) => prev.map((m) => (m.id === assistantIdRef.current ? { ...m, status: 'failed', errorCode: d.code } : m)));
            }
            break;
          }
        }
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (assistantIdRef.current) flushDelta(assistantIdRef.current);
        setMessages((prev) => prev.map((m) => (m.status === 'streaming' ? { ...m, status: 'cancelled' } : m)));
      } else {
        setFatalError(err instanceof ApiError ? err.message : '网络错误，请重试');
        setMessages((prev) => prev.map((m) => (m.status === 'streaming' ? { ...m, status: 'failed' } : m)));
      }
    } finally {
      setStreaming(false); setThinking('');
      abortRef.current = null;
      assistantIdRef.current = null;
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }
  }, [streaming, router, projectId, queryClient, appendDelta, flushDelta]);

  const stop = useCallback(() => { abortRef.current?.abort(); }, []);

  const retry = useCallback((messageId: string) => {
    const idx = messages.findIndex((m) => m.id === messageId);
    const userMsg = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
    if (userMsg) void send(userMsg.content, []);
  }, [messages, send]);

  // 任务完成 → 刷新消息（generated_image 附件挂到 assistant 消息）
  const onTaskDone = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['messages', activeIdRef.current] });
  }, [queryClient]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [messages, thinking, tasks]);

  return (
    <div className="flex h-screen">
      <Sidebar activeId={conversationId} />
      <main className="flex flex-1 flex-col">
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
            {messages.length === 0 && tasks.length === 0 && (
              <div className="pt-32 text-center">
                <h2 className="text-2xl font-semibold">你好，我是 AI 助手</h2>
                <p className="mt-2 text-zinc-400">可以问我任何问题，或试试："帮我做一张科技感主图"</p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id}>
                <MessageBubble message={m} streaming={m.status === 'streaming'} onRetry={() => retry(m.id)} />
                {runIds[m.id] && <RunTimeline runId={runIds[m.id]} />}
              </div>
            ))}
            {tasks.map((t) => (
              <TaskCard key={t.taskId} taskId={t.taskId} kind={t.kind} onDone={onTaskDone} />
            ))}
            {currentTool && (
              <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">
                🔧 正在执行 {currentTool}
              </div>
            )}
            {thinking && <p className="text-xs text-zinc-500">💭 {thinking}</p>}
            {fatalError && <p className="text-sm text-red-400">⚠ {fatalError}</p>}
          </div>
        </div>
        <div className="border-t border-zinc-800 p-4">
          <div className="mx-auto max-w-3xl">
            <ChatInput onSend={send} onStop={stop} streaming={streaming} />
          </div>
        </div>
      </main>
    </div>
  );
}
