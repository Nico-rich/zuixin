import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from '@/app/(chat)/chat/components/sidebar';
import { jsonResponse, renderWithQuery } from './helpers';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: pushMock, back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/chat',
}));

/**
 * M13-W10：对话侧栏写面（项目重命名/删除、对话重命名）。
 *
 * 契约（apps/api/src/modules/projects|conversations 控制器）：
 *  - PATCH  /api/v1/projects/:id        { name }  → project.write（无组织归属的历史个人项目 = 仅本人）
 *  - DELETE /api/v1/projects/:id
 *  - PATCH  /api/v1/conversations/:id   { title } → 归属本人即可
 *  - DELETE /api/v1/conversations/:id
 * DOM 口径：AppShell 内**不得**出现 ul>li / section / h1-h6 / 裸 group（app-shell.test.tsx 锁定）。
 */
const PROJECTS = [
  { id: 'p-1', name: '项目甲', updatedAt: '2026-09-29T00:00:00.000Z' },
  { id: 'p-2', name: '项目乙', updatedAt: '2026-09-29T00:00:00.000Z' },
];
const CONVERSATIONS = [{ id: 'c-1', title: '会话甲', updatedAt: new Date().toISOString(), projectId: null }];

function mockSidebarApi(over: { forbidden?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      return over.forbidden
        ? jsonResponse({ error: { code: 'FORBIDDEN', message: '权限不足' } }, 403)
        : jsonResponse({ data: {} });
    }
    if (url.includes('/api/v1/projects')) return jsonResponse({ data: PROJECTS });
    if (url.includes('/api/v1/conversations')) return jsonResponse({ data: CONVERSATIONS });
    if (url.includes('/api/v1/auth/me')) return jsonResponse({ data: { user: { email: 'dev@example.com', displayName: '开发者' } } });
    return jsonResponse({ data: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const writeCall = (fetchMock: ReturnType<typeof vi.fn>, method: string) =>
  fetchMock.mock.calls.find((c) => ((c[1] as RequestInit)?.method ?? 'GET') === method);

async function renderSidebar() {
  renderWithQuery(<Sidebar activeId="c-1" />);
  await screen.findByText('会话甲');
}

describe('Sidebar：项目管理（重命名/删除）', () => {
  it('展开管理面板后逐项目给出重命名/删除入口', async () => {
    mockSidebarApi();
    await renderSidebar();
    expect(screen.queryByTitle('重命名项目')).not.toBeInTheDocument(); // 默认收起，避免常态噪声
    await act(async () => {
      fireEvent.click(screen.getByTitle('管理项目（重命名/删除）'));
      await Promise.resolve();
    });
    expect(screen.getAllByTitle('重命名项目')).toHaveLength(2);
    expect(screen.getAllByTitle('删除项目')).toHaveLength(2);
  });

  it('重命名项目：PATCH /projects/:id（body=name），成功后关闭弹窗', async () => {
    const fetchMock = mockSidebarApi();
    await renderSidebar();
    fireEvent.click(screen.getByTitle('管理项目（重命名/删除）'));
    fireEvent.click(screen.getAllByTitle('重命名项目')[0]);

    const input = screen.getByLabelText('项目名称') as HTMLInputElement;
    expect(input.value).toBe('项目甲');
    fireEvent.change(input, { target: { value: '项目甲（改名）' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await Promise.resolve();
    });

    const patch = writeCall(fetchMock, 'PATCH')!;
    expect(String(patch[0])).toBe('/api/v1/projects/p-1');
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ name: '项目甲（改名）' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('删除项目：二次确认后 DELETE /projects/:id', async () => {
    const fetchMock = mockSidebarApi();
    await renderSidebar();
    fireEvent.click(screen.getByTitle('管理项目（重命名/删除）'));
    fireEvent.click(screen.getAllByTitle('删除项目')[0]);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('项目甲');
    expect(dialog).toHaveTextContent('项目下的对话不会被删除'); // 后果说明必须如实
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删除' }));
      await Promise.resolve();
    });
    const del = writeCall(fetchMock, 'DELETE')!;
    expect(String(del[0])).toBe('/api/v1/projects/p-1');
  });

  it('403（无 project.write）：渲染权限徽标而不是静默失败', async () => {
    mockSidebarApi({ forbidden: true });
    await renderSidebar();
    fireEvent.click(screen.getByTitle('管理项目（重命名/删除）'));
    fireEvent.click(screen.getAllByTitle('重命名项目')[0]);
    const input = screen.getByLabelText('项目名称');
    fireEvent.change(input, { target: { value: '越权改名' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await Promise.resolve();
    });
    expect(await screen.findByTestId('forbidden-badge')).toHaveTextContent('403 权限不足 · 需要 project.write 权限');
  });
});

describe('Sidebar：对话重命名/删除', () => {
  it('重命名对话：PATCH /conversations/:id（body=title），且不触发跳转（stopPropagation）', async () => {
    const fetchMock = mockSidebarApi();
    await renderSidebar();
    pushMock.mockClear();
    fireEvent.click(screen.getByTitle('重命名对话'));
    expect(pushMock).not.toHaveBeenCalled(); // 行点击 = 切会话；操作按钮必须拦截冒泡

    const input = screen.getByLabelText('对话标题') as HTMLInputElement;
    expect(input.value).toBe('会话甲');
    fireEvent.change(input, { target: { value: '会话甲（改名）' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await Promise.resolve();
    });

    const patch = writeCall(fetchMock, 'PATCH')!;
    expect(String(patch[0])).toBe('/api/v1/conversations/c-1');
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ title: '会话甲（改名）' });
  });

  it('删除当前会话：DELETE 后跳回 /chat（不停留在已删除会话）', async () => {
    const fetchMock = mockSidebarApi();
    await renderSidebar();
    pushMock.mockClear();
    fireEvent.click(screen.getByTitle('删除对话'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删除' }));
      await Promise.resolve();
    });
    const del = writeCall(fetchMock, 'DELETE')!;
    expect(String(del[0])).toBe('/api/v1/conversations/c-1');
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/chat'));
  });
});
