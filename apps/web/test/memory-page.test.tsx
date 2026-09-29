import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MemoryPage from '@/app/memory/page';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * 记忆页（M13-W3）——断言全部打在**真实 HTTP 语义**上：
 * 页面必须发 `GET /api/v1/memories`（过滤参数经 service 拼查询串），写路径打到后端既有 4 个端点
 * （POST / PATCH / DELETE /memories），**不使用**不存在的 `GET /memories/:id`（后端没有该端点）。
 *
 * 覆盖：列表 / 过滤与搜索 / 空态 / 加载 / 错误重试 / 新建（user 与 project 两种范围）/ 编辑（提升）/ 删除确认；
 * 另钉住「记忆正文按不可信数据渲染」——纯文本，绝不解析 HTML。
 */

type Memory = {
  id: string; userId: string; scope: 'user' | 'project'; projectId: string | null; content: string;
  category: 'preference' | 'profile' | 'instruction' | 'project_context' | 'workflow' | 'other';
  source: string | null; sourceMessageId: string | null; importance: number; confidence: number | null;
  status: 'candidate' | 'active' | 'rejected'; lastUsedAt: string | null; metadata: unknown;
  createdAt: string; updatedAt: string;
};

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'm1', userId: 'u1', scope: 'user', projectId: null, content: '用户偏好简体中文',
    category: 'preference', source: 'manual', sourceMessageId: null, importance: 80, confidence: null,
    status: 'active', lastUsedAt: null, metadata: null,
    createdAt: '2026-09-27T10:00:00.000Z', updatedAt: '2026-09-28T10:00:00.000Z',
    ...overrides,
  };
}

const PROJECTS = [{ id: 'p1', name: '秋季campaign', description: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }];

function mockMemoryApi(init: { memories?: Memory[]; onList?: (url: string) => Response } = {}) {
  const memories = init.memories ?? [memory()];
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, opts?: RequestInit) => {
    const url = String(input);
    const method = opts?.method ?? 'GET';
    calls.push([url, opts]);
    if (method === 'GET' && url === '/api/v1/projects') return jsonResponse({ data: PROJECTS });
    if (method === 'GET' && url.startsWith('/api/v1/memories')) {
      return init.onList ? init.onList(url) : jsonResponse({ data: memories });
    }
    if (method === 'POST' && url === '/api/v1/memories') {
      const body = JSON.parse(String(opts?.body)) as Partial<Memory>;
      return jsonResponse({ data: memory({ id: 'm-new', ...body, status: 'candidate' }) });
    }
    if (method === 'PATCH' && url.startsWith('/api/v1/memories/')) {
      const body = JSON.parse(String(opts?.body)) as Partial<Memory>;
      return jsonResponse({ data: memory({ id: url.split('/').pop()!, ...body }) });
    }
    if (method === 'DELETE' && url.startsWith('/api/v1/memories/')) return jsonResponse({ data: { id: 'm1' } });
    throw new Error(`未预期的请求：${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

const row = (content: string) => screen.getByText(content).closest('tr') as HTMLTableRowElement;
const listUrls = (calls: Array<[string, RequestInit | undefined]>) => calls.filter(([u, o]) => (o?.method ?? 'GET') === 'GET' && u.startsWith('/api/v1/memories')).map(([u]) => u);

describe('记忆页：列表 / 过滤 / 空态 / 错误', () => {
  it('渲染记忆行（内容/范围/分类/状态/重要度/更新时间），默认请求不带过滤参数', async () => {
    const { calls } = mockMemoryApi({ memories: [
      memory({ id: 'm1', content: '用户偏好简体中文', scope: 'user', status: 'active', importance: 80 }),
      memory({ id: 'm2', content: '项目语气更活泼', scope: 'project', projectId: 'p1', category: 'project_context', status: 'candidate', importance: 40 }),
    ] });
    renderWithQuery(<MemoryPage />);

    expect(await screen.findByText('用户偏好简体中文')).toBeInTheDocument();
    const first = row('用户偏好简体中文');
    expect(within(first).getByText('用户级')).toBeInTheDocument();
    expect(within(first).getByText('偏好')).toBeInTheDocument();
    expect(within(first).getByText('已生效')).toBeInTheDocument();
    expect(within(first).getByText('80')).toBeInTheDocument();
    expect(within(first).getByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)).toBeInTheDocument();

    const second = row('项目语气更活泼');
    expect(within(second).getByText('项目级')).toBeInTheDocument();
    expect(within(second).getByText('秋季campaign')).toBeInTheDocument(); // projectId → 项目名
    expect(within(second).getByText('候选')).toBeInTheDocument();

    expect(listUrls(calls)).toEqual(['/api/v1/memories']);
  });

  it('记忆正文按不可信数据渲染：纯文本，不解析 HTML', async () => {
    const payload = '<img src=x onerror="alert(1)">';
    const { fetchMock } = mockMemoryApi({ memories: [memory({ content: payload })] });
    const { container } = renderWithQuery(<MemoryPage />);

    expect(await screen.findByText(payload)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('过滤与搜索：范围/项目/状态/关键词经 service 拼成查询串（顺序与编码由 service 钉死）', async () => {
    const { calls } = mockMemoryApi();
    renderWithQuery(<MemoryPage />);
    await screen.findByText('用户偏好简体中文');

    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'project' } });
    await waitFor(() => expect(listUrls(calls).at(-1)).toBe('/api/v1/memories?scope=project'));

    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'p1' } });
    await waitFor(() => expect(listUrls(calls).at(-1)).toBe('/api/v1/memories?scope=project&projectId=p1'));

    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'active' } });
    await waitFor(() => expect(listUrls(calls).at(-1)).toBe('/api/v1/memories?scope=project&projectId=p1&status=active'));

    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '偏好' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(listUrls(calls).at(-1)).toBe('/api/v1/memories?scope=project&projectId=p1&status=active&q=%E5%81%8F%E5%A5%BD'));
  });

  it('空态：无过滤与有过滤给不同引导', async () => {
    mockMemoryApi({ memories: [] });
    renderWithQuery(<MemoryPage />);
    expect(await screen.findByText('还没有记忆')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'rejected' } });
    expect(await screen.findByText('没有匹配的记忆')).toBeInTheDocument();
  });

  it('错误态：展示错误与重试，重试后渲染列表', async () => {
    let first = true;
    mockMemoryApi({ onList: () => {
      if (first) { first = false; return jsonResponse({ error: { code: 'INTERNAL', message: '服务异常' } }, 500); }
      return jsonResponse({ data: [memory()] });
    } });
    renderWithQuery(<MemoryPage />);

    const banner = await screen.findByRole('alert');
    expect(within(banner).getByText('记忆列表加载失败')).toBeInTheDocument();
    expect(within(banner).getByText('服务异常')).toBeInTheDocument();

    fireEvent.click(within(banner).getByRole('button', { name: '重试' }));
    expect(await screen.findByText('用户偏好简体中文')).toBeInTheDocument();
  });
});

describe('记忆页：新建 / 编辑 / 删除', () => {
  it('新建（用户级）：POST /memories，默认候选状态由服务端裁定', async () => {
    const { calls } = mockMemoryApi();
    renderWithQuery(<MemoryPage />);
    await screen.findByText('用户偏好简体中文');

    fireEvent.click(screen.getByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByLabelText('记忆内容'), { target: { value: '回复先给结论' } });
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: 'instruction' } });
    fireEvent.change(screen.getByLabelText('重要度（0-100）'), { target: { value: '70' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const created = calls.find(([u, o]) => u === '/api/v1/memories' && o?.method === 'POST');
      expect(created, '必须打到 POST /api/v1/memories').toBeTruthy();
      expect(JSON.parse(String(created![1]!.body))).toEqual({
        scope: 'user', content: '回复先给结论', category: 'instruction', importance: 70,
      });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('新建（项目级）：未选项目本地拦截；选项目后上送 projectId', async () => {
    const { calls } = mockMemoryApi();
    renderWithQuery(<MemoryPage />);
    await screen.findByText('用户偏好简体中文');

    fireEvent.click(screen.getByRole('button', { name: '新建记忆' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('记忆内容'), { target: { value: '本项目交付用英文' } });
    fireEvent.change(within(dialog).getByLabelText('范围'), { target: { value: 'project' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await screen.findByText('项目级记忆必须选择项目')).toBeInTheDocument();
    expect(calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText('项目'), { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      const created = calls.find(([u, o]) => u === '/api/v1/memories' && o?.method === 'POST');
      expect(JSON.parse(String(created![1]!.body))).toEqual({
        scope: 'project', projectId: 'p1', content: '本项目交付用英文', category: 'preference', importance: 50,
      });
    });
  });

  it('编辑：PATCH /memories/:id（内容/分类/重要度/状态），范围与项目不可改', async () => {
    const { calls } = mockMemoryApi({ memories: [memory({ id: 'm1', content: '用户偏好简体中文', status: 'candidate' })] });
    renderWithQuery(<MemoryPage />);
    await screen.findByText('用户偏好简体中文');

    fireEvent.click(within(row('用户偏好简体中文')).getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog');
    // 范围/项目在编辑态是只读文本（后端 PATCH 不接受这两个字段）
    expect(within(dialog).getByText('用户级')).toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox', { name: '范围' })).toBeNull();

    fireEvent.change(within(dialog).getByLabelText('记忆内容'), { target: { value: '用户偏好简体中文（含英文术语）' } });
    fireEvent.change(within(dialog).getByLabelText('状态'), { target: { value: 'active' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const patched = calls.find(([u, o]) => u === '/api/v1/memories/m1' && o?.method === 'PATCH');
      expect(patched, '必须打到 PATCH /api/v1/memories/:id').toBeTruthy();
      expect(JSON.parse(String(patched![1]!.body))).toEqual({
        content: '用户偏好简体中文（含英文术语）', category: 'preference', importance: 80, status: 'active',
      });
    });
  });

  it('删除：二次确认（取消不发请求；确认发 DELETE 并刷新列表）', async () => {
    const { calls } = mockMemoryApi();
    renderWithQuery(<MemoryPage />);
    await screen.findByText('用户偏好简体中文');

    fireEvent.click(within(row('用户偏好简体中文')).getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter(([, o]) => o?.method === 'DELETE')).toHaveLength(0);

    fireEvent.click(within(row('用户偏好简体中文')).getByRole('button', { name: '删除' }));
    const confirm = await screen.findByRole('dialog');
    fireEvent.click(within(confirm).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(calls.some(([u, o]) => u === '/api/v1/memories/m1' && o?.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(listUrls(calls).length).toBeGreaterThanOrEqual(2));
  });
});
