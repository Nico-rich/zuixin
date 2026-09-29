'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, API_BASE } from '@/lib/api';
import { consumeSSE } from '@/lib/sse';
import { Sidebar } from './sidebar';
import { ChatInput } from './chat-input';
import { MessageBubble } from './message-bubble';
import { TaskCard, type TaskStreamEvent } from './task-card';
import { RunTimeline } from './run-timeline';
import { ActiveTask, AttachmentView, ChatMessage, ChatStreamEventMap } from './types';

interface HistoryMessage {
  id: string; role: 'user' | 'assistant'; content: string; status: string; errorCode: string | null;
  intentType: string | null; createdAt: string;
  attachments: Array<{ id: string; kind: AttachmentView['kind']; type: AttachmentView['type']; mimeType: string; originalName: string | null }>;
}

export function ChatWorkspace({ conversationId }: { conversationId?: string }) {
  const searchParams = useSearchParams();
  const projectId = searchParams.get('projectId') ?? undefined;
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** 侧边栏高亮用的当前会话 id：新会话在首条消息落库后由 SSE 回填（不依赖路由重挂载） */
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(conversationId);
  const [tasks, setTasks] = useState<ActiveTask[]>([]);
  // M10-P13（ARCH-07）：task 通道 SSE 事件（taskId → 最新事件），透传给对应 TaskCard 免轮询
  const [taskEvents, setTaskEvents] = useState<Record<string, TaskStreamEvent>>({});
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

  // 历史消息加载（含附件）。
  // M11-P13 真实浏览器验证实抓的缺陷修复：查询键必须用 **activeConversationId（状态）**——
  // 新会话 id 在首条消息落库后由 SSE message_start 回填，而路由 prop conversationId 在
  // pushState（非 router 导航）下永不更新 ⇒ 原查询对 /chat 新建会话**永不启用**，
  // 任务完成后 onTaskDone 的 invalidateQueries(['messages', activeIdRef.current]) 打在
  // 从未注册的 key 上 ⇒ 附件（generated_image）永不刷新到消息气泡。
  const history = useQuery({
    queryKey: ['messages', activeConversationId],
    queryFn: async () => {
      if (!activeConversationId) return [];
      const res = await apiFetch<{ data: HistoryMessage[] }>(`/api/v1/conversations/${activeConversationId}/messages`);
      return res.data.map((m) => ({ ...m, status: m.status as ChatMessage['status'] }));
    },
    enabled: !!activeConversationId,
  });

  useEffect(() => {
    // M11-P13 修复：**按 id 合并而非整体替换**——message_start 后查询启用触发的 refetch
    // 与 SSE 文本增量存在竞态（整体替换会把已上屏的流式内容打回服务器旧快照）；
    // 空数据不覆盖本地状态（单测与降级场景）；流式中的消息保留本地 content/status，
    // 其余字段（含任务完成后挂上的 attachments）以服务器行为准。
    setMessages((prev) => {
      const server = history.data ?? [];
      if (server.length === 0) return prev;
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const s of server) {
        const existing = byId.get(s.id);
        byId.set(s.id, existing && existing.status === 'streaming'
          ? { ...s, content: existing.content, status: existing.status }
          : (existing
            ? { ...s, content: existing.content || s.content, status: existing.status === 'completed' ? existing.status : s.status }
            : s));
      }
      return server.map((s) => byId.get(s.id)!);
    });
    // 注意：**不在此清 thinking/fatalError/tasks**——message_start 后启用查询触发的 refetch
    // 与流式状态存在竞态（refetch 落地会误清「正在分析需求…」/错误横幅/刚建的任务卡）。
    // thinking 由 message_end 清、fatalError 由下一次 send 清、tasks 由路由重挂载重置。
    // 注意：**不在此清 tasks**——新会话的 refetch（message_start 后启用查询）与 task.created
    // SSE 事件存在竞态，若在此 setTasks([]) 会把刚建的任务卡清掉（卡片只由 SSE 添加）。
    // 会话切换由路由导航重挂载组件天然重置。
  }, [history.data]);

  const flushDelta = useCallback((targetId: string) => {
    const delta = deltaBuf.current;
    deltaBuf.current = '';
    if (!delta) return;
    setMessages((prev) => prev.map((m) => (m.id === targetId ? { ...m, content: m.content + delta } : m)));
  }, []);

  const appendDelta = useCallback((messageId: string, delta: string) => {
    deltaBuf.current += delta;
    // 40ms 节流合并渲染：**已排队的窗口不再顺延**（原实现在每个 token 上 clearTimeout 重置计时器，
    // 于是 token 间隔 < 40ms 时计时器永远不触发 —— 真实 provider 与 mock（MOCK_DELAY_MS=30）都稳定低于
    // 该间隔，导致流式期间始终只显示「正在生成…」，全部文本在 message_end 才一次性上屏。
    // 真实浏览器实测见 apps/web/e2e/chat-streaming.spec.ts 的中间态采样断言。）
    if (deltaTimer.current) return;
    deltaTimer.current = setTimeout(() => {
      deltaTimer.current = null;
      flushDelta(messageId);
    }, 40);
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
              setActiveConversationId(d.conversationId);
              // M11-P13（真实浏览器验证暴露的缺陷修复）：**不再**用 router.replace 换 URL。
              // /chat 与 /chat/[id] 是两个 page 组件，App Router 导航会卸载当前 ChatWorkspace 实例，
              // SSE 回调（闭包持有旧实例的 setState）随之失效，而新实例从历史接口读到的是一条
              // content='' / status='streaming' 的消息 → 首条消息永远停在「正在生成…▍」。
              // 改用原生 History API 只换地址栏：Next 15 会把 URL 同步进路由状态（usePathname 等），
              // 组件树不重挂载，流式渲染与侧边栏高亮由本实例继续驱动；
              // 刷新后地址栏仍是 /chat/<id>，回放同一会话（已由 e2e 覆盖）。
              window.history.replaceState(null, '', `/chat/${d.conversationId}${projectId ? `?projectId=${projectId}` : ''}`);
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
          // M10-P13（ARCH-07）：任务进度/完成由 api 从 Redis `task` 通道转发到本 SSE 流
          // （不落库判断，只做展示与对账触发——DB 仍是任务事实源）
          case 'task.progress': {
            const d = data as ChatStreamEventMap['task_progress'];
            setTaskEvents((prev) => ({ ...prev, [d.taskId]: { ...d, type: 'task.progress' } }));
            break;
          }
          case 'task.completed': {
            const d = data as ChatStreamEventMap['task_completed'];
            setTaskEvents((prev) => ({ ...prev, [d.taskId]: { ...d, type: 'task.completed' } }));
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
  }, [streaming, projectId, queryClient, appendDelta, flushDelta]);

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
      <Sidebar activeId={activeConversationId} />
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
              <TaskCard key={t.taskId} taskId={t.taskId} kind={t.kind} onDone={onTaskDone} event={taskEvents[t.taskId] ?? null} />
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
