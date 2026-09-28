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

  it('message_start 建立 assistant 气泡；新会话时跳转到 /chat/{conversationId}', async () => {
    const h = await setupChatHarness();
    await sendMessage('你好');
    await h.push(frame('message_start', { messageId: 'm-1', conversationId: 'conv-9', createdAt: '2026-09-28T00:00:00.000Z' }));
    await screen.findByText('正在生成…');
    expect(replaceMock).toHaveBeenCalledWith('/chat/conv-9', { scroll: false });
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
