import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ApprovalsPage from '@/app/approvals/page';
import { ToastProvider } from '@/components/ui/toast';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * /approvals 页面（M13-W9 闭环断裂修复）：
 *  - 列表是"待审批"（默认 status=requested，可切状态）；
 *  - 决定必须**显式点击 + Dialog 二次确认**（LLM 不参与）；
 *  - 页面只展示**绑定摘要**（actionType + payloadHash + boundAt），
 *    敏感 payload 绝不出现在任何渲染路径（这是本页最重要的一条断言）；
 *  - 服务端 409（已处理/已过期）→ 提示 + 刷新列表，不做本地状态改写。
 */

const PENDING = {
  id: 'ap-1', status: 'requested', riskLevel: 'high', reason: '对外发布营销素材',
  projectId: null, agentRunId: 'run-1', toolCallId: 'tc-1',
  expiresAt: '2026-09-30T00:00:00.000Z', approvedAt: null, rejectedAt: null, cancelledAt: null,
  createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
  payload: {
    __binding: {
      actionType: 'external_action.publish',
      payloadHash: 'sha256:deadbeef',
      boundAt: '2026-09-29T00:00:00.000Z',
    },
    accessToken: 'SENSITIVE-PAYLOAD-MARKER',
  },
};

const DECIDED = { ...PENDING, id: 'ap-2', status: 'rejected', reason: '历史拒绝', rejectedAt: '2026-09-28T00:00:00.000Z' };

function mockApi(items: unknown[] = [PENDING], decideStatus = 201, decideBody?: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/api/v1/approvals/') && method === 'POST') {
      if (decideStatus !== 201) {
        return jsonResponse(decideBody ?? { error: { code: 'APPROVAL_NOT_PENDING', message: '审批已处理' } }, decideStatus);
      }
      const id = url.split('/approvals/')[1].split('/')[0];
      const status = url.endsWith('/approve') ? 'approved' : 'rejected';
      return jsonResponse({ data: { ...PENDING, id, status } });
    }
    if (url.includes('/api/v1/approvals')) return jsonResponse({ data: items });
    throw new Error(`未预期的请求：${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('/approvals 审批页（M13-W9）', () => {
  it('默认拉取"待审批"，渲染理由/风险/绑定摘要，且敏感 payload 绝不渲染', async () => {
    const fetchMock = mockApi();
    renderWithQuery(<ApprovalsPage />);

    expect(await screen.findByText('对外发布营销素材')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toContain('status=requested');
    // 绑定摘要 = 唯一可见的 payload 片段
    expect(screen.getByText('external_action.publish')).toBeInTheDocument();
    expect(screen.getByText('sha256:deadbeef')).toBeInTheDocument();
    expect(screen.getByText('风险 high')).toBeInTheDocument();
    // 敏感 payload 全页零出现（含 Dialog 未打开时）
    expect(document.body.textContent).not.toContain('SENSITIVE-PAYLOAD-MARKER');
    expect(document.body.textContent).not.toContain('accessToken');
  });

  it('状态筛选：切换后按新状态重新请求（服务端过滤，前端不本地筛）', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('status=rejected')) return jsonResponse({ data: [DECIDED] });
      return jsonResponse({ data: [PENDING] });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWithQuery(<ApprovalsPage />);
    await screen.findByText('对外发布营销素材');

    fireEvent.change(screen.getByLabelText('审批状态'), { target: { value: 'rejected' } });

    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('status=rejected'))).toBe(true));
    expect(await screen.findByText('历史拒绝')).toBeInTheDocument();
  });

  it('通过：Dialog 二次确认展示绑定摘要 → 确认后 POST /approve（LLM 不参与决定）', async () => {
    const fetchMock = mockApi();
    renderWithQuery(<ApprovalsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^通过审批：/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('确认通过该审批？')).toBeInTheDocument();
    expect(within(dialog).getByText('external_action.publish')).toBeInTheDocument();
    expect(within(dialog).getByText('sha256:deadbeef')).toBeInTheDocument();
    expect(within(dialog).getByText('对外发布营销素材')).toBeInTheDocument();
    expect(dialog.textContent).not.toContain('SENSITIVE-PAYLOAD-MARKER');

    fireEvent.click(within(dialog).getByRole('button', { name: '确认通过' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1]?.method ?? 'GET') === 'POST');
      expect(post).toBeTruthy();
      expect(String(post![0])).toContain('/api/v1/approvals/ap-1/approve');
    });
    // 提交后关闭对话框（决定已交给服务端，页面不做本地状态改写）
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('拒绝：走 /reject 端点，且确认按钮语义变为"确认拒绝"', async () => {
    const fetchMock = mockApi();
    renderWithQuery(<ApprovalsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^拒绝审批：/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('确认拒绝该审批？')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '确认拒绝' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1]?.method ?? 'GET') === 'POST');
      expect(String(post![0])).toContain('/api/v1/approvals/ap-1/reject');
    });
  });

  it('服务端 409（已处理/已过期）→ 错误提示 + 关闭对话框（不以本地状态掩盖裁决）', async () => {
    mockApi([PENDING], 409);
    renderWithQuery(<ToastProvider><ApprovalsPage /></ToastProvider>);

    fireEvent.click(await screen.findByRole('button', { name: /^通过审批：/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认通过' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('决定未生效');
    expect(alert.textContent).toContain('已被处理或已过期');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('空列表 → 明确的空态文案（不伪造行）', async () => {
    mockApi([]);
    renderWithQuery(<ApprovalsPage />);
    expect(await screen.findByText('没有符合该状态的审批请求')).toBeInTheDocument();
  });
});
