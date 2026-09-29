import { Suspense } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WorkflowsPage from '@/app/workflows/page';
import WorkflowDetailPage from '@/app/workflows/[id]/page';
import WorkflowRunsPage from '@/app/workflows/[id]/runs/page';
import { jsonResponse, renderWithQuery } from './helpers';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: pushMock, back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/workflows',
}));

/**
 * M13-W10：workflows 写面补全。
 *  - 列表页新建（POST /workflows，definition 必填且 steps ≥ 1）
 *  - 详情页编辑（PATCH /workflows/:id）/ 删除（DELETE）/ webhook 密钥轮换（POST webhook/rotate）
 *  - 运行历史页取消（POST workflows/runs/:id/cancel）/ 重试（POST workflows/runs/:id/retry）
 * 失败一律如实呈现（403 权限徽标 / 409 状态冲突原文），本地校验（非法 JSON）不发请求。
 */

const SUMMARY = {
  id: 'wf-1', name: '素材生产流', description: '描述', status: 'draft' as const,
  updatedAt: '2026-09-29T00:00:00.000Z', versions: [{ version: 1, status: 'draft' }], _count: { runs: 2 },
};

const DETAIL = {
  id: 'wf-1', name: '素材生产流', description: '描述', status: 'draft',
  versions: [{ id: 'v-1', version: 1, status: 'draft', createdAt: '2026-09-29T00:00:00.000Z', definition: { steps: [{ id: 'step-1', type: 'output' }] } }],
  triggerInfo: { webhook: { token: 'tok-1', secret: null as string | null } },
};

const RUNS = [
  { id: 'run-1', status: 'running', triggerType: 'manual', attempt: 1, createdAt: '2026-09-29T00:00:00.000Z', completedAt: null, version: { version: 1 } },
  { id: 'run-2', status: 'failed', triggerType: 'manual', attempt: 1, createdAt: '2026-09-29T00:00:00.000Z', completedAt: '2026-09-29T00:01:00.000Z', version: { version: 1 } },
];

const writeCall = (fetchMock: ReturnType<typeof vi.fn>, method: string, urlPart?: string) =>
  fetchMock.mock.calls.find((c) => ((c[1] as RequestInit)?.method ?? 'GET') === method
    && (urlPart === undefined || String(c[0]).includes(urlPart)));

/* ------------------------------- 列表页：新建 ------------------------------- */

describe('WorkflowsPage：新建工作流（M13-W10）', () => {
  function mockList() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST') {
        return jsonResponse({ data: { ...SUMMARY, id: 'wf-new', name: '新流程' } });
      }
      return jsonResponse({ data: [SUMMARY] });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function openDialog() {
    renderWithQuery(<WorkflowsPage />);
    await screen.findByText('素材生产流');
    fireEvent.click(screen.getByRole('button', { name: '新建工作流' }));
    return screen.findByRole('dialog');
  }

  it('definition 模板可直接提交：POST /workflows（name/description/definition）', async () => {
    const fetchMock = mockList();
    await openDialog();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新流程' } });
    fireEvent.change(screen.getByLabelText('描述（可选）'), { target: { value: '  用于回归  ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }));
      await Promise.resolve();
    });

    const post = writeCall(fetchMock, 'POST')!;
    expect(String(post[0])).toBe('/api/v1/workflows');
    const body = JSON.parse(String((post[1] as RequestInit).body)) as { name: string; description?: string; definition: { steps: unknown[] } };
    expect(body.name).toBe('新流程');
    expect(body.description).toBe('用于回归'); // 首尾空白去除
    expect(Array.isArray(body.definition.steps)).toBe(true); // 模板必须能过服务端 steps ≥ 1 校验
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('definition 非法 JSON：本地拦截、不发请求、弹窗保留', async () => {
    const fetchMock = mockList();
    await openDialog();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新流程' } });
    fireEvent.change(screen.getByLabelText('definition（JSON）'), { target: { value: '{不是 JSON' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }));
      await Promise.resolve();
    });
    expect(screen.getByText('definition 必须是合法 JSON')).toBeInTheDocument();
    expect(writeCall(fetchMock, 'POST')).toBeUndefined();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('403（无 workflow.write）：弹窗内渲染权限徽标', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') return jsonResponse({ error: { code: 'FORBIDDEN', message: '权限不足' } }, 403);
      return jsonResponse({ data: [SUMMARY] });
    }));
    await openDialog();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新流程' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }));
      await Promise.resolve();
    });
    expect(await screen.findByTestId('forbidden-badge')).toHaveTextContent('403 权限不足 · 需要 workflow.write 权限');
  });
});

/* ------------------------------- 详情页：编辑/删除/轮换 ------------------------------- */

describe('WorkflowDetailPage：编辑 / 删除 / webhook 轮换（M13-W10）', () => {
  function mockDetail(over: { patch?: Response; del?: Response; rotate?: Response } = {}) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/webhook/rotate')) {
        return over.rotate ?? jsonResponse({ data: { token: 'tok-2', secret: 'sec-new', previousSecretExpiresAt: null } });
      }
      if (method === 'PATCH') return over.patch ?? jsonResponse({ data: { ...DETAIL, name: '改名后的流程' } });
      if (method === 'DELETE') return over.del ?? jsonResponse({ data: { deleted: true } });
      return jsonResponse({ data: DETAIL });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function renderDetail() {
    await act(async () => {
      renderWithQuery(
        <Suspense fallback={<p>页面加载中…</p>}>
          <WorkflowDetailPage params={Promise.resolve({ id: 'wf-1' })} />
        </Suspense>,
      );
    });
    await screen.findByRole('heading', { name: '素材生产流' });
  }

  it('编辑：PATCH /workflows/:id，definition 预填最新版本且提示草稿/已发布的写入语义', async () => {
    const fetchMock = mockDetail();
    await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/最新版本仍是草稿/)).toBeInTheDocument();
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('素材生产流');
    expect((screen.getByLabelText('definition（JSON，留空 = 不改定义）') as HTMLTextAreaElement).value).toContain('"step-1"');

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '改名后的流程' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await Promise.resolve();
    });

    const patch = writeCall(fetchMock, 'PATCH')!;
    expect(String(patch[0])).toBe('/api/v1/workflows/wf-1');
    const body = JSON.parse(String((patch[1] as RequestInit).body)) as { name: string; description: string | null; definition?: unknown };
    expect(body.name).toBe('改名后的流程');
    expect(body.description).toBe('描述');
    expect(body.definition).toEqual({ steps: [{ id: 'step-1', type: 'output' }] });
    await screen.findByRole('heading', { name: '改名后的流程' }); // 以服务端返回刷新
  });

  it('编辑：非法 JSON 本地拦截且不发 PATCH', async () => {
    const fetchMock = mockDetail();
    await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('definition（JSON，留空 = 不改定义）'), { target: { value: '}{' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await Promise.resolve();
    });
    expect(screen.getByText(/definition 必须是合法 JSON（留空表示不改定义）/)).toBeInTheDocument();
    expect(writeCall(fetchMock, 'PATCH')).toBeUndefined();
  });

  it('删除：二次确认 → DELETE /workflows/:id 并回到列表', async () => {
    const fetchMock = mockDetail();
    await renderDetail();
    pushMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('不可恢复');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
      await Promise.resolve();
    });
    expect(String(writeCall(fetchMock, 'DELETE')![0])).toBe('/api/v1/workflows/wf-1');
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/workflows'));
  });

  it('webhook 轮换：POST rotate 后展示一次性新密钥；未轮换时提示明文不可再读', async () => {
    const fetchMock = mockDetail();
    await renderDetail();
    // 未轮换：token 可见但没有明文 secret
    expect(screen.getByText(/POST \/api\/v1\/hooks\/workflows\/tok-1/)).toBeInTheDocument();
    expect(screen.getByText(/明文无法再次读出/)).toBeInTheDocument();
    expect(screen.queryByText(/secret 仅显示这一次/)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '轮换密钥' }));
      await Promise.resolve();
    });
    expect(String(writeCall(fetchMock, 'POST', '/webhook/rotate')![0])).toBe('/api/v1/workflows/wf-1/webhook/rotate');
    expect(await screen.findByText('sec-new')).toBeInTheDocument();
    expect(screen.getByText(/secret 仅显示这一次/)).toBeInTheDocument();
    expect(screen.getByText(/POST \/api\/v1\/hooks\/workflows\/tok-2/)).toBeInTheDocument();
  });

  it('轮换失败（409 需先轮换）：原文呈现错误码，不谎报成功', async () => {
    mockDetail({ rotate: jsonResponse({ error: { code: 'WEBHOOK_SECRET_ROTATION_REQUIRED', message: '密钥需要轮换后才能继续' } }, 409) });
    await renderDetail();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '轮换密钥' }));
      await Promise.resolve();
    });
    expect(await screen.findByText(/密钥需要轮换后才能继续（WEBHOOK_SECRET_ROTATION_REQUIRED）/)).toBeInTheDocument();
    expect(screen.queryByText('sec-new')).not.toBeInTheDocument();
  });
});

/* ------------------------------- 运行历史页：取消/重试 ------------------------------- */

describe('WorkflowRunsPage：行内取消 / 重试（M13-W10）', () => {
  function mockRuns() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST') return jsonResponse({ data: { id: 'run-3', status: 'queued' } });
      if (url.includes('/runs?take')) return jsonResponse({ data: RUNS });
      return jsonResponse({ data: RUNS });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function renderRuns() {
    await act(async () => {
      renderWithQuery(
        <Suspense fallback={<p>页面加载中…</p>}>
          <WorkflowRunsPage params={Promise.resolve({ id: 'wf-1' })} />
        </Suspense>,
      );
    });
    await screen.findByText('运行历史');
    await screen.findByText('running');
  }

  it('状态映射：仅运行中的行给取消、仅终态行给重试', async () => {
    mockRuns();
    await renderRuns();
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]).getByRole('button', { name: '取消' })).toBeInTheDocument();
    expect(within(rows[0]).queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(within(rows[1]).getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(within(rows[1]).queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
  });

  it('取消：确认后 POST workflows/runs/:id/cancel', async () => {
    const fetchMock = mockRuns();
    await renderRuns();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('取消运行');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '取消运行' }));
      await Promise.resolve();
    });
    expect(String(writeCall(fetchMock, 'POST')![0])).toBe('/api/v1/workflows/runs/run-1/cancel');
  });

  it('重试：POST workflows/runs/:id/retry 并以同一输入新建下一次运行', async () => {
    const fetchMock = mockRuns();
    await renderRuns();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
      await Promise.resolve();
    });
    expect(String(writeCall(fetchMock, 'POST')![0])).toBe('/api/v1/workflows/runs/run-2/retry');
    // 重试后重新拉取列表（新 run 会出现在列表里）
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/runs?take')).length).toBeGreaterThanOrEqual(2));
  });

  it('取消失败（409 已结束）：原文呈现错误码，不静默', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return jsonResponse({ error: { code: 'WORKFLOW_RUN_NOT_CANCELLABLE', message: '运行已结束，无法取消' } }, 409);
      }
      return jsonResponse({ data: RUNS });
    }));
    await renderRuns();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '取消运行' }));
      await Promise.resolve();
    });
    expect(await screen.findByText(/运行已结束，无法取消（WORKFLOW_RUN_NOT_CANCELLABLE）/)).toBeInTheDocument();
  });
});
