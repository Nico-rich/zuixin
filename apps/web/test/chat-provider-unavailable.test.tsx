import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatWorkspace } from '@/app/(chat)/chat/components/chat-workspace';
import { jsonResponse, renderWithQuery } from './helpers';

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/chat',
}));

const frame = (name: string, data: Record<string, unknown>) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;

/**
 * M13+（模型配置页）：PROVIDER_UNAVAILABLE 的对话呈现。
 * - SSE error 帧带该 code → 渲染「前往模型配置」引导（data-testid=provider-unavailable-hint），
 *   **不**出现 p.text-red-400（那是既有 e2e 的"页面错误"口径——此处是可恢复的配置态）；
 * - 其他错误码（如 PROVIDER_TIMEOUT）→ 保持既有红字文案（旧契约不回归）。
 */
async function setupChatHarness(): Promise<{
  controller: ReadableStreamDefaultController<Uint8Array>;
  push: (chunk: string) => Promise<void>;
}> {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/v1/chat')) {
      const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      init?.signal?.addEventListener('abort', () => {
        try { controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch { /* 已关闭 */ }
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes('/api/v1/conversations') || url.includes('/api/v1/projects')) return jsonResponse({ data: [] });
    if (url.includes('/api/v1/tasks/')) return jsonResponse({ data: { id: 't-1', type: 'image', status: 'processing', progress: 10, statusMessage: '启动中', errorMessage: null } });
    if (url.includes('/api/v1/auth/me')) return jsonResponse({ data: { user: { email: 'admin@example.com', displayName: '管理员', role: 'admin' } } });
    return jsonResponse({ data: null });
  });
  vi.stubGlobal('fetch', fetchMock);

  renderWithQuery(<ChatWorkspace />);
  await screen.findByRole('button', { name: /新对话/ });

  return {
    controller,
    push: async (chunk: string) => {
      await act(async () => { controller.enqueue(encoder.encode(chunk)); await Promise.resolve(); });
    },
  };
}

async function sendMessage() {
  const textarea = screen.getByPlaceholderText(/输入你的问题/);
  fireEvent.change(textarea, { target: { value: '帮我干活' } });
  fireEvent.click(screen.getByTitle('发送'));
}

describe('对话 PROVIDER_UNAVAILABLE 呈现（M13+ 模型配置页）', () => {
  it('SSE error(PROVIDER_UNAVAILABLE) → 模型配置引导；无 p.text-red-400（可恢复配置态，非页面错误）', async () => {
    const { push } = await setupChatHarness();
    await sendMessage();
    await waitFor(async () => {
      await push(frame('message_start', { messageId: 'm-assist' }));
      await push(frame('error', { code: 'PROVIDER_UNAVAILABLE', message: '没有可用的 provider 承载能力 text_generation（拒绝原因：disabled/no_model）', requestId: 'r1' }));
      await push(frame('message_end', { messageId: 'm-assist', status: 'failed' }));
    });

    const hint = await screen.findByTestId('provider-unavailable-hint');
    expect(hint).toHaveTextContent('当前没有可用的模型服务');
    expect(hint.querySelector('a')).toHaveAttribute('href', '/settings/models');
    expect(document.querySelectorAll('p.text-red-400')).toHaveLength(0);
  });

  it('其他错误码（PROVIDER_TIMEOUT）→ 既有红字文案（旧契约不回归）', async () => {
    const { push } = await setupChatHarness();
    await sendMessage();
    await waitFor(async () => {
      await push(frame('message_start', { messageId: 'm-assist' }));
      await push(frame('error', { code: 'PROVIDER_TIMEOUT', message: 'provider 响应超时', requestId: 'r2' }));
      await push(frame('message_end', { messageId: 'm-assist', status: 'failed' }));
    });

    expect(await screen.findByText(/⚠ provider 响应超时/)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid="provider-unavailable-hint"]')).toHaveLength(0);
  });
});
