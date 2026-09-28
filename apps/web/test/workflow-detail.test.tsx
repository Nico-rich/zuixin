import { Suspense } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WorkflowDetailPage from '@/app/workflows/[id]/page';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * apps/web 当前没有独立的「审批 UI」（全仓 grep approval/approved/rejected 无命中，api 的
 * Human Approval 只有接口与事件）；与之最接近的“状态驱动操作按钮”在工作流详情页：
 * 发布/归档按钮按 workflow.status 启用或禁用。本文件覆盖该状态映射 + 错误状态展示。
 */

type Detail = {
  id: string; name: string; description: string | null; status: string;
  versions: Array<{ id: string; version: number; status: string; createdAt: string }>;
  triggerInfo?: { webhook: { token: string; secret: string | null } | null };
};

function detail(overrides: Partial<Detail> = {}): Detail {
  return {
    id: 'wf-1', name: '素材生产流', description: '描述', status: 'draft',
    versions: [{ id: 'v-1', version: 3, status: 'draft', createdAt: '2026-09-28T00:00:00.000Z' }],
    ...overrides,
  };
}

function mockWorkflowApi(initial: Detail, post?: (path: string) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      return post ? post(url) : jsonResponse({ data: initial });
    }
    return jsonResponse({ data: initial });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 页面用 React 19 `use(params)` 取路由参数：render 必须包在 async act 里，
 *  否则 Suspense 边界外的 promise 决议不会被 flush（测试会永远停在 fallback）。 */
async function renderPage() {
  await act(async () => {
    renderWithQuery(
      <Suspense fallback={<p>页面加载中…</p>}>
        <WorkflowDetailPage params={Promise.resolve({ id: 'wf-1' })} />
      </Suspense>,
    );
  });
  await screen.findByRole('heading', { name: '素材生产流' });
}

const publishBtn = () => screen.getByRole('button', { name: '发布最新版本' });
const archiveBtn = () => screen.getByRole('button', { name: '归档' });
/** 标题栏的状态徽标（与版本列表里的 status 文本区分开） */
const statusBadge = () => within(screen.getByRole('heading', { name: '素材生产流' }).parentElement!).getByText(/^(draft|published|archived)$/);

describe('工作流详情页：状态驱动的操作按钮', () => {
  it('draft：发布与归档均可操作，且不显示手动触发区', async () => {
    mockWorkflowApi(detail({ status: 'draft' }));
    await renderPage();
    expect(statusBadge()).toHaveTextContent('draft');
    expect(publishBtn()).toBeEnabled();
    expect(archiveBtn()).toBeEnabled();
    expect(screen.queryByRole('button', { name: '触发运行' })).not.toBeInTheDocument();
  });

  it('published：发布按钮禁用（幂等保护），归档仍可操作，显示手动触发区', async () => {
    mockWorkflowApi(detail({ status: 'published' }));
    await renderPage();
    expect(publishBtn()).toBeDisabled();
    expect(archiveBtn()).toBeEnabled();
    expect(screen.getByRole('button', { name: '触发运行' })).toBeInTheDocument();
  });

  it('archived：归档按钮禁用，发布按钮仍可操作（重新发布）', async () => {
    mockWorkflowApi(detail({ status: 'archived' }));
    await renderPage();
    expect(archiveBtn()).toBeDisabled();
    expect(publishBtn()).toBeEnabled();
    expect(screen.queryByRole('button', { name: '触发运行' })).not.toBeInTheDocument();
  });

  it('点击发布：POST publish 并用返回的最新详情刷新状态与按钮', async () => {
    const fetchMock = mockWorkflowApi(detail({ status: 'draft' }), () =>
      jsonResponse({ data: detail({ status: 'published' }) }));
    await renderPage();
    fireEvent.click(publishBtn());
    await waitFor(() => expect(publishBtn()).toBeDisabled());
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST')!;
    expect(String(post[0])).toBe('/api/v1/workflows/wf-1/publish');
    expect(statusBadge()).toHaveTextContent('published');
  });

  it('操作失败：展示“操作失败”错误，按钮状态不变', async () => {
    mockWorkflowApi(detail({ status: 'draft' }), () =>
      jsonResponse({ error: { code: 'WORKFLOW_NOT_PUBLISHED', message: '无可发布的版本' } }, 409));
    await renderPage();
    fireEvent.click(publishBtn());
    expect(await screen.findByText('操作失败')).toBeInTheDocument();
    expect(publishBtn()).toBeEnabled();
    expect(statusBadge()).toHaveTextContent('draft');
  });

  it('版本列表渲染版本号与状态（快照不可变：历史 published 与当前 draft 并存）', async () => {
    mockWorkflowApi(detail({
      versions: [
        { id: 'v-2', version: 2, status: 'published', createdAt: '2026-09-27T00:00:00.000Z' },
        { id: 'v-3', version: 3, status: 'draft', createdAt: '2026-09-28T00:00:00.000Z' },
      ],
    }));
    await renderPage();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
    const versionList = screen.getByRole('list');
    expect(within(versionList).getByText('published')).toBeInTheDocument();
    expect(within(versionList).getByText('draft')).toBeInTheDocument();
    expect(statusBadge()).toHaveTextContent('draft'); // 工作流自身状态仍是 draft
  });

  it('加载失败：整页展示“工作流加载失败”错误态', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'NOT_FOUND', message: '不存在' } }, 404)));
    await act(async () => {
      renderWithQuery(
        <Suspense fallback={<p>页面加载中…</p>}>
          <WorkflowDetailPage params={Promise.resolve({ id: 'wf-x' })} />
        </Suspense>,
      );
    });
    expect(await screen.findByText('工作流加载失败')).toBeInTheDocument();
  });
});

describe('工作流详情页：手动触发运行', () => {
  it('payload 合法：POST /runs 并展示触发结果', async () => {
    const fetchMock = mockWorkflowApi(detail({ status: 'published' }), (url) =>
      url.endsWith('/runs') ? jsonResponse({ data: { id: 'run-1', status: 'queued' } }) : jsonResponse({ data: detail() }));
    await renderPage();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"prompt":"猫"}' } });
    fireEvent.click(screen.getByRole('button', { name: '触发运行' }));
    expect(await screen.findByText('已触发运行 run-1（queued）')).toBeInTheDocument();
    const runCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/runs'))!;
    expect(JSON.parse((runCall[1] as RequestInit).body as string)).toEqual({ payload: { prompt: '猫' } });
  });

  it('payload 非法 JSON：本地报错且不发起请求', async () => {
    const fetchMock = mockWorkflowApi(detail({ status: 'published' }));
    await renderPage();
    const callsBefore = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{不是 JSON' } });
    fireEvent.click(screen.getByRole('button', { name: '触发运行' }));
    expect(await screen.findByText('payload 必须是 JSON')).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});

describe('工作流详情页：Webhook 凭据一次性展示', () => {
  it('有 secret 时展示端点与签名说明（仅本次响应可见）', async () => {
    mockWorkflowApi(detail({
      status: 'published',
      triggerInfo: { webhook: { token: 'tok-abc', secret: 'sec-xyz' } },
    }));
    await renderPage();
    expect(screen.getByText(/secret 仅显示这一次/)).toBeInTheDocument();
    expect(screen.getByText('sec-xyz')).toBeInTheDocument();
    expect(screen.getByText(/POST \/api\/v1\/hooks\/workflows\/tok-abc/)).toBeInTheDocument();
  });

  it('无 secret（已展示过）时不渲染凭据区块', async () => {
    mockWorkflowApi(detail({ status: 'published', triggerInfo: { webhook: { token: 'tok-abc', secret: null } } }));
    await renderPage();
    expect(screen.queryByText(/secret 仅显示这一次/)).not.toBeInTheDocument();
  });
});
