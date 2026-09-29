import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatWorkspace } from '@/app/(chat)/chat/components/chat-workspace';
import { jsonResponse, renderWithQuery } from './helpers';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: pushMock, back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/chat/c-1',
}));

/**
 * M13-W10：chat 消息编辑/删除（web 侧）。
 *
 * 后端 M10-P3 已就绪（apps/api/src/modules/chat/chat.controller.ts）：
 *  - PATCH  /api/v1/chat/messages/:id { content } → 仅本人的 user 消息（他人/自己的 assistant → 403/404）
 *  - DELETE /api/v1/chat/messages/:id
 * 本文件锁定前端契约：入口只在本人 user 消息上、以服务端返回为准（不做乐观改写）、
 * 失败按 ApiError 原文呈现（403 权限徽标 / 400 校验 / 404 反枚举都不静默）。
 */

interface HistoryRow {
  id: string; role: 'user' | 'assistant'; content: string; status: string; errorCode: string | null;
  intentType: string | null; createdAt: string; editedAt: string | null; attachments: never[];
}

const row = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  id: 'm-1', role: 'user', content: '原始问题', status: 'completed', errorCode: null,
  intentType: null, createdAt: '2026-09-29T00:00:00.000Z', editedAt: null, attachments: [], ...over,
});

/** 有状态 mock：DELETE 后历史里不再返回该行（与真实服务端硬删除一致，避免"删了又回来"的假绿） */
function mockChatApi(seed: HistoryRow[]) {
  let rows = [...seed];
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/messages/') || url.includes('/chat/messages/')) {
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { content: string };
        rows = rows.map((r) => (r.id === 'm-1' ? { ...r, content: body.content, editedAt: '2026-09-29T01:00:00.000Z' } : r));
        return jsonResponse({ data: { id: 'm-1', content: body.content, editedAt: '2026-09-29T01:00:00.000Z' } });
      }
      if (method === 'DELETE') {
        rows = rows.filter((r) => r.id !== 'm-1');
        return jsonResponse({ data: { id: 'm-1', deleted: true } });
      }
    }
    if (url.includes('/messages')) return jsonResponse({ data: rows });
    if (url.includes('/api/v1/conversations') || url.includes('/api/v1/projects')) return jsonResponse({ data: [] });
    if (url.includes('/api/v1/auth/me')) return jsonResponse({ data: { user: { email: 'dev@example.com', displayName: null } } });
    return jsonResponse({ data: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

const SEED = [row(), row({ id: 'm-2', role: 'assistant', content: '这是回答' })];

async function renderWorkspace() {
  renderWithQuery(<ChatWorkspace conversationId="c-1" />);
  await screen.findByText('原始问题');
  await screen.findByText('这是回答');
}

describe('ChatWorkspace：消息编辑', () => {
  it('仅本人 user 消息有编辑入口（assistant 无入口）', async () => {
    mockChatApi(SEED);
    await renderWorkspace();
    expect(screen.getAllByTitle('编辑消息')).toHaveLength(1);
    expect(screen.getAllByTitle('删除消息')).toHaveLength(1);
  });

  it('编辑：PATCH /chat/messages/:id（body=content），以服务端返回内容为准并显示「已编辑」', async () => {
    const { fetchMock } = mockChatApi(SEED);
    await renderWorkspace();
    fireEvent.click(screen.getByTitle('编辑消息'));

    const textarea = screen.getByLabelText('消息内容') as HTMLTextAreaElement;
    expect(textarea.value).toBe('原始问题'); // 预填当前内容
    fireEvent.change(textarea, { target: { value: '改过的问题' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await Promise.resolve();
    });

    const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'PATCH')!;
    expect(String(patch[0])).toBe('/api/v1/chat/messages/m-1');
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ content: '改过的问题' });

    await screen.findByText('改过的问题');
    expect(screen.getByText('已编辑')).toBeInTheDocument();
    expect(screen.queryByText('原始问题')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('编辑失败（403）：弹窗不关闭，渲染权限徽标而非静默吞掉', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'PATCH') {
        return jsonResponse({ error: { code: 'MESSAGE_EDIT_FORBIDDEN', message: '只能编辑自己发送的消息' } }, 403);
      }
      if (url.includes('/messages')) return jsonResponse({ data: SEED });
      if (url.includes('/api/v1/auth/me')) return jsonResponse({ data: { user: { email: 'dev@example.com', displayName: null } } });
      return jsonResponse({ data: [] });
    }));
    await renderWorkspace();
    fireEvent.click(screen.getByTitle('编辑消息'));
    fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '越权改写' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await Promise.resolve();
    });

    expect(await screen.findByTestId('forbidden-badge')).toHaveTextContent('403 权限不足');
    expect(screen.getByRole('dialog')).toBeInTheDocument(); // 失败不关弹窗（用户可复制内容/重试）
    expect(screen.getByText('原始问题')).toBeInTheDocument(); // 本地内容未被乐观改写
  });
});

describe('ChatWorkspace：消息删除', () => {
  it('删除需二次确认：DELETE /chat/messages/:id 后气泡消失', async () => {
    const { fetchMock } = mockChatApi(SEED);
    await renderWorkspace();
    fireEvent.click(screen.getByTitle('删除消息'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('删除消息');
    expect(dialog).toHaveTextContent('删除后不可恢复');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删除' }));
      await Promise.resolve();
    });

    const del = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'DELETE')!;
    expect(String(del[0])).toBe('/api/v1/chat/messages/m-1');
    await waitFor(() => expect(screen.queryByText('原始问题')).not.toBeInTheDocument());
    expect(screen.getByText('这是回答')).toBeInTheDocument(); // 只删目标消息，不波及其它
  });

  it('删除失败（404 反枚举）：弹窗保留并原文呈现错误码', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'DELETE') {
        return jsonResponse({ error: { code: 'NOT_FOUND', message: '消息不存在' } }, 404);
      }
      if (url.includes('/messages')) return jsonResponse({ data: SEED });
      if (url.includes('/api/v1/auth/me')) return jsonResponse({ data: { user: { email: 'dev@example.com', displayName: null } } });
      return jsonResponse({ data: [] });
    }));
    await renderWorkspace();
    fireEvent.click(screen.getByTitle('删除消息'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删除' }));
      await Promise.resolve();
    });
    expect(await screen.findByText(/消息不存在（NOT_FOUND）/)).toBeInTheDocument();
    expect(screen.getByText('原始问题')).toBeInTheDocument();
  });

  it('取消确认：不发任何写请求', async () => {
    const { fetchMock } = mockChatApi(SEED);
    await renderWorkspace();
    fireEvent.click(screen.getByTitle('删除消息'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.every((c) => ((c[1] as RequestInit)?.method ?? 'GET') === 'GET')).toBe(true);
  });
});
