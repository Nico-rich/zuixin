import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ArtifactsPage from '@/app/artifacts/page';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * /artifacts 制品库（M13-W9 闭环断裂修复之二）：
 *  - 列表：类型 Badge / 标题 / 时间 + 有文件时的代理下载链接；
 *  - 详情预览按类型适配：图片走**同源代理**、报告渲染文本、分析提示事实/推测分层；
 *  - 响应里没有 `storageKey` / `idempotencyKey`（服务端投影），页面也绝不构造；
 *  - 页面**没有任何写操作入口**（制品的唯一写路径是 Agent 工具）。
 */

function item(over: Record<string, unknown> = {}) {
  return {
    id: 'art-1', type: 'report', title: '周度经营报告', summary: '转化率下降',
    content: null, status: 'ready', projectId: null, conversationId: null, messageId: null,
    taskId: null, runId: 'run-1', toolCallId: 'tc-1',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
    downloadUrl: null, ...over,
  };
}

function mockApi(list: unknown[], detail: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/api\/v1\/artifacts\/[^?]+$/.test(url)) return jsonResponse({ data: detail });
    if (url.includes('/api/v1/artifacts')) return jsonResponse({ data: list });
    throw new Error(`未预期的请求：${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('/artifacts 制品库（M13-W9）', () => {
  it('列表：类型/标题/时间 + 有文件时给**代理**下载链接（不泄漏内部列、无写操作入口）', async () => {
    const fetchMock = mockApi(
      [
        item({ downloadUrl: '/api/v1/artifacts/art-1/download' }),
        item({ id: 'art-2', type: 'image', title: '配图', downloadUrl: null }),
      ],
      item(),
    );
    renderWithQuery(<ArtifactsPage />);

    expect(await screen.findByText('周度经营报告')).toBeInTheDocument();
    // 类型 Badge（用卡片作用域断言：类型筛选下拉里也有同名字面量）
    expect(within(screen.getByTestId('artifact-art-1')).getByText('报告')).toBeInTheDocument();
    expect(within(screen.getByTestId('artifact-art-2')).getByText('图片')).toBeInTheDocument();
    expect(within(screen.getByTestId('artifact-art-1')).getByText(/创建于/)).toBeInTheDocument();

    const download = screen.getByRole('link', { name: /下载文件/ });
    expect(download).toHaveAttribute('href', '/api/v1/artifacts/art-1/download');
    // 只有一条制品有文件 → 只渲染一个下载链接
    expect(screen.getAllByRole('link', { name: /下载文件/ })).toHaveLength(1);

    // 只读面：不存在任何写操作按钮（新建/编辑/删除制品）
    const writeButton = /新建|创建|编辑|删除|上传/;
    const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    expect(buttons.filter((name) => writeButton.test(name))).toEqual([]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/artifacts');
  });

  it('类型筛选：切换后请求带 ?type=image（服务端过滤）', async () => {
    const fetchMock = mockApi([item()], item());
    renderWithQuery(<ArtifactsPage />);
    await screen.findByText('周度经营报告');

    fireEvent.change(screen.getByLabelText('制品类型'), { target: { value: 'image' } });

    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('type=image'))).toBe(true));
  });

  it('详情（报告）：正文以纯文本呈现，未被渲染为 HTML；无文件时明确提示', async () => {
    mockApi([item()], item({ content: { markdown: '# 标题\n<b>不应成为 HTML</b>' }, downloadUrl: null }));
    renderWithQuery(<ArtifactsPage />);

    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText(/# 标题/)).toBeInTheDocument();
    expect(within(dialog).getByText(/不应成为 HTML/)).toBeInTheDocument(); // 作为**文本**出现
    expect(dialog.querySelector('b')).toBeNull(); // 绝不注入 HTML
    expect(within(dialog).getByText('该制品无关联文件（纯结构化内容）')).toBeInTheDocument();
  });

  it('详情（图片）：有文件 → 图片走同源代理端点；外链只作为链接、不自动内联加载', async () => {
    mockApi(
      [item({ id: 'art-img', type: 'image', title: '主图', downloadUrl: '/api/v1/artifacts/art-img/download' })],
      item({
        id: 'art-img', type: 'image', title: '主图', downloadUrl: '/api/v1/artifacts/art-img/download',
        content: { url: 'https://untrusted.example/cat.png' },
      }),
    );
    renderWithQuery(<ArtifactsPage />);

    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }));
    const dialog = await screen.findByRole('dialog');

    const img = await within(dialog).findByRole('img', { name: '主图' });
    expect(img).toHaveAttribute('src', '/api/v1/artifacts/art-img/download'); // 同源代理，不是外链
    const link = within(dialog).getByRole('link', { name: 'https://untrusted.example/cat.png' });
    expect(link).toHaveAttribute('href', 'https://untrusted.example/cat.png');
    expect(within(dialog).getByText(/不自动加载外部资源/)).toBeInTheDocument();
  });

  it('详情（分析）：提示 facts/derived 为服务端计算、possibleCauses/recommendations 为 LLM 推测', async () => {
    mockApi(
      [item({ id: 'art-an', type: 'analysis', title: '销售分析' })],
      item({
        id: 'art-an', type: 'analysis', title: '销售分析',
        content: { facts: { revenue: 800 }, possibleCauses: ['流量质量下降（推测）'], recommendations: ['优化主图'] },
      }),
    );
    renderWithQuery(<ArtifactsPage />);

    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText(/服务端计算/)).toBeInTheDocument();
    expect(within(dialog).getByText(/LLM 推测/)).toBeInTheDocument();
    expect(within(dialog).getByText(/"revenue": 800/)).toBeInTheDocument();
  });

  it('空列表 → 空态文案', async () => {
    mockApi([], item());
    renderWithQuery(<ArtifactsPage />);
    expect(await screen.findByText('还没有该类型的制品')).toBeInTheDocument();
  });
});
