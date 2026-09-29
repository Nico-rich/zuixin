import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatWorkspace } from '@/app/(chat)/chat/components/chat-workspace';
import { jsonResponse, renderWithQuery, until } from './helpers';

const replaceMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock, back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/chat',
}));

/** 线上帧格式与 apps/api SSEWriter 一致：`event: <name>\ndata: <json>\n\n`，data 内含 type 字段 */
const frame = (name: string, data: Record<string, unknown>) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;

interface Harness {
  controller: ReadableStreamDefaultController<Uint8Array>;
  push: (chunk: string) => Promise<void>;
  endStream: () => Promise<void>;
  fetchMock: ReturnType<typeof vi.fn>;
}

/** 拦截 /api/v1/chat：返回可控 SSE 流；其余端点返回空数据 */
async function setupChatHarness(chatStatus = 200, chatErrorBody: unknown = null): Promise<Harness> {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/v1/chat')) {
      if (chatStatus !== 200) return jsonResponse(chatErrorBody, chatStatus);
      const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      // 真实 fetch 在 signal abort 时让流以 AbortError 失败——mock 需保持同等语义
      init?.signal?.addEventListener('abort', () => {
        try { controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch { /* 已关闭 */ }
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes('/api/v1/conversations') || url.includes('/api/v1/projects')) return jsonResponse({ data: [] });
    // 任务卡片的兜底轮询（ARCH-07：SSE 为主、轮询兜底）
    if (url.includes('/api/v1/tasks/')) {
      return jsonResponse({ data: { id: 't-1', type: 'image', status: 'processing', progress: 10, statusMessage: '启动中', errorMessage: null } });
    }
    if (url.includes('/api/v1/auth/me')) return jsonResponse({ data: { user: { email: 'dev@example.com', displayName: null } } });
    return jsonResponse({ data: null });
  });
  vi.stubGlobal('fetch', fetchMock);

  renderWithQuery(<ChatWorkspace />);
  // Sidebar 的字段（新对话按钮）出现即视为挂载完成
  await screen.findByRole('button', { name: /新对话/ });

  const push = async (chunk: string) => {
    await act(async () => {
      controller.enqueue(encoder.encode(chunk));
      await Promise.resolve();
    });
  };
  const endStream = async () => {
    await act(async () => { controller.close(); await Promise.resolve(); });
  };
  return { controller, push, endStream, fetchMock };
}

async function sendMessage(text: string): Promise<void> {
  const textarea = screen.getByPlaceholderText(/输入你的问题/);
  fireEvent.change(textarea, { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByTitle('发送'));
    await Promise.resolve();
  });
}

describe('ChatWorkspace 消息流（SSE 解析 → 渲染）', () => {
  it('发送后立刻显示用户气泡与思考态，并以 SSE 请求后端', async () => {
    const h = await setupChatHarness();
    await sendMessage('你好');
    expect(screen.getByText('你好')).toBeInTheDocument();
    expect(screen.getByText(/正在分析需求/)).toBeInTheDocument();
    const chatCall = h.fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/v1/chat'))!;
    expect((chatCall[1] as RequestInit).method).toBe('POST');
  });

  it('message_start 建立 assistant 气泡；新会话仅换地址栏（不触发路由导航 → 不重挂载、流式不中断）', async () => {
    const h = await setupChatHarness();
    await sendMessage('你好');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'conv-9', createdAt: '2026-09-28T00:00:00.000Z' }));
    await screen.findByText('正在生成…');
    expect(window.location.pathname).toBe('/chat/conv-9');
    // M11-P13 回归：不得走 next/navigation 的 router.replace —— /chat → /chat/[id] 是两个 page 组件，
    // 路由导航会卸载 ChatWorkspace（SSE 回调失效），新实例只读到 content='' / status='streaming' 的历史消息，
    // 首条消息永远停在“正在生成…”。真实浏览器证据：apps/web/e2e/chat-streaming.spec.ts。
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('M11-P13：token 间隔小于节流窗口时仍按窗口上屏（节流不得退化为“等静默”的防抖）', async () => {
    const h = await setupChatHarness();
    await sendMessage('你好');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'c', createdAt: 'T' }));
    // 连续推入、彼此无间隔（真实流式里 token 间隔 30ms < 40ms 窗口）
    for (const ch of '逐字上屏') await h.push(frame('message_delta', { delta: ch }));
    // 关键：**不**推 message_end —— 内容必须在流未结束时已上屏（旧实现会一直停在空内容）
    await screen.findByText('逐字上屏');
  });

  it('多个 message_delta 帧（含分片到达）拼接为完整文本', async () => {
    const h = await setupChatHarness();
    await sendMessage('你好');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'c', createdAt: 'T' }));
    const f1 = frame('message_delta', { delta: '第一段' });
    await h.push(f1.slice(0, 12));
    await h.push(f1.slice(12));
    await h.push(frame('message_delta', { delta: '，第二段' }));
    await screen.findByText(/第一段，第二段/);
  });

  it('message_end(completed) 收流：状态转完成、光标与思考态消失', async () => {
    const h = await setupChatHarness();
    await sendMessage('你好');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'c', createdAt: 'T' }));
    await h.push(frame('message_delta', { delta: '最终答案' }));
    await h.push(frame('message_end', { messageId: 'm-1', status: 'completed' }));
    await screen.findByText('最终答案');
    // 收流边界：message_end 立即撤下光标；连接关闭后整体退出流式态
    await waitFor(() => expect(screen.queryByText('▍')).not.toBeInTheDocument());
    await h.endStream();
    await waitFor(() => {
      expect(screen.queryByText('▍')).not.toBeInTheDocument();
      expect(screen.queryByText(/正在分析需求/)).not.toBeInTheDocument();
      // 收流后输入区恢复“发送”（非“停止”）
      expect(screen.getByTitle('发送')).toBeInTheDocument();
    });
  });

  it('error 帧：顶部展示错误文案且气泡标记失败（带错误码与重试按钮）', async () => {
    const h = await setupChatHarness();
    await sendMessage('你好');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'c', createdAt: 'T' }));
    await h.push(frame('error', { code: 'PROVIDER_TIMEOUT', message: '模型响应超时，请重试' }));
    await screen.findByText(/⚠ 模型响应超时，请重试/);
    await screen.findByText(/生成失败（PROVIDER_TIMEOUT）/);
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument();
  });

  it('点击停止：中断流后消息状态为“已停止”（cancelled）而非失败', async () => {
    const h = await setupChatHarness();
    await sendMessage('你好');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'c', createdAt: 'T' }));
    await h.push(frame('message_delta', { delta: '写到一半' }));
    await screen.findByText('写到一半');
    await act(async () => {
      fireEvent.click(screen.getByTitle('停止生成'));
      await Promise.resolve();
    });
    await screen.findByText('已停止');
    expect(screen.queryByText(/生成失败/)).not.toBeInTheDocument();
  });

  it('run.created 事件把 runId 绑定到当前 assistant 气泡并渲染执行详情入口', async () => {
    const h = await setupChatHarness();
    await sendMessage('帮我做一张图');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'c', createdAt: 'T' }));
    await h.push(frame('run.created', { runId: 'run-7', agentId: 'agent-1' }));
    await screen.findByRole('button', { name: /执行详情/ });
    // 展开时按 runId 拉取时间线
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /执行详情/ }));
      await Promise.resolve();
    });
    await until(() => h.fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/v1/agent-runs/run-7/timeline')));
  });

  it('ARCH-07：task.created 渲染任务卡；task.progress 帧经 SSE 贯通到卡片（不等 2s 轮询）', async () => {
    const h = await setupChatHarness();
    await sendMessage('帮我做一张图');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'c', createdAt: 'T' }));
    await h.push(frame('task.created', { taskId: 't-1', kind: 'image' }));
    await screen.findByText('图片生成');
    await screen.findByText('启动中'); // 初始态来自兜底轮询（DB）

    await h.push(frame('task.progress', { taskId: 't-1', progress: 66, message: '生成中 66%' }));
    await screen.findByText('生成中 66%'); // 事件即时上屏（无需等下一轮轮询）
    expect((document.querySelector('.bg-zinc-400') as HTMLElement).style.width).toBe('66%');
  });

  it('ARCH-07：task.completed 帧 → 卡片转完成态（信号来自 SSE，终态以 DB 对账收尾）', async () => {
    const h = await setupChatHarness();
    await sendMessage('帮我做一张图');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'c', createdAt: 'T' }));
    await h.push(frame('task.created', { taskId: 't-1', kind: 'image' }));
    await screen.findByText('图片生成');
    await h.push(frame('task.completed', { taskId: 't-1', progress: 100 }));
    await screen.findByText('✅ 完成');
    // 事件驱动的即时对账：GET /tasks/t-1 被再拉取一次（DB 是事实源）
    await until(() => h.fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/v1/tasks/t-1')).length >= 2);
  });

  it('无法 JSON.parse 的 data 帧被忽略，不影响后续正常帧', async () => {
    const h = await setupChatHarness();
    await sendMessage('你好');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'c', createdAt: 'T' }));
    await h.push('event: message_delta\ndata: {oops-not-json\n\n');
    await h.push(frame('message_delta', { delta: '仍然可用' }));
    await screen.findByText('仍然可用');
    expect(screen.queryByText(/oops-not-json/)).not.toBeInTheDocument();
  });

  it('HTTP 非 2xx 建流失败：展示后端错误码文案且不产生 assistant 气泡', async () => {
    await setupChatHarness(429, { error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' } });
    await sendMessage('你好');
    await screen.findByText(/⚠ 请求过于频繁，请稍后再试/);
    expect(screen.queryByText('正在生成…')).not.toBeInTheDocument();
    expect(screen.getByText('你好')).toBeInTheDocument();
  });
});

/**
 * M13-W10：agent 事件呈现。
 * api 的 chat SSE 白名单本就转发 agent.start/agent.end（chat.service.ts），但 web 此前整体丢弃
 * （types.ts 声明了 agent_start/agent_end 却无人消费）→ 用户看不出「当前由哪个 Agent 在处理」。
 * 载荷只有 agentId/runId（字段集被 packages/shared zod + type-drift 防线锁定，不得加 agentName），
 * 因此这里只呈现 agentId 的截断标签，绝不臆造可读名称、也不为此多打一次 admin-only 的 GET /agents。
 */
describe('ChatWorkspace：agent.start / agent.end 状态呈现（M13-W10）', () => {
  it('agent.start 复用 status 通道显示「正在由 X Agent 处理…」（后续 status 事件照旧覆盖）', async () => {
    const h = await setupChatHarness();
    await sendMessage('帮我做一张图');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'c', createdAt: 'T' }));
    expect(screen.getByText(/正在分析需求/)).toBeInTheDocument();

    await h.push(frame('agent.start', { agentId: 'agent-1', runId: 'run-1' }));
    await screen.findByText(/正在由 agent-1 Agent 处理…/);

    await h.push(frame('status', { stage: 'planning', message: '正在规划步骤…' }));
    await screen.findByText(/正在规划步骤…/);
    expect(screen.queryByText(/正在由 agent-1 Agent 处理/)).not.toBeInTheDocument();
  });

  it('长 agentId 截断为 8 位 + 省略号（不臆造名称、也不撑破状态行）', async () => {
    const h = await setupChatHarness();
    await sendMessage('帮我做一张图');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'c', createdAt: 'T' }));
    await h.push(frame('agent.start', { agentId: '0193a1b2-ffff-4eee-9ddd-0123456789ab', runId: 'run-1' }));
    await screen.findByText(/正在由 0193a1b2… Agent 处理…/);
  });

  it('agent.end(completed) 清空状态行；非 completed 原文呈现结束状态', async () => {
    const h = await setupChatHarness();
    await sendMessage('帮我做一张图');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'c', createdAt: 'T' }));
    await h.push(frame('agent.start', { agentId: 'agent-1', runId: 'run-1' }));
    await screen.findByText(/正在由 agent-1 Agent 处理…/);

    await h.push(frame('agent.end', { agentId: 'agent-1', runId: 'run-1', status: 'completed' }));
    await waitFor(() => expect(screen.queryByText(/正在由 agent-1 Agent 处理/)).not.toBeInTheDocument());

    await h.push(frame('agent.start', { agentId: 'agent-1', runId: 'run-2' }));
    await screen.findByText(/正在由 agent-1 Agent 处理…/);
    await h.push(frame('agent.end', { agentId: 'agent-1', runId: 'run-2', status: 'timeout' }));
    await screen.findByText(/Agent 处理结束（timeout）/);
  });
});
