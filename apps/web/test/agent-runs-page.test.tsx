import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import AgentRunsPage from '@/app/agent-runs/page';
import { renderWithQuery } from './helpers';

/**
 * Agent 运行列表（M13-W2）——**按会话查看**：
 * - 后端 `GET /agent-runs` 的 conversationId 必填 → 未选会话时呈现引导态，不发列表请求；
 * - 选会话后才请求，并把状态/步骤/尝试次数/耗时投影直渲；
 * - 空态 TableEmpty、错误态+重试、会话列表失败态。
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({ id: 'run-1' }),
  usePathname: () => '/agent-runs',
  useSearchParams: () => new URLSearchParams(),
}));

const runsService = vi.hoisted(() => ({ listAgentRuns: vi.fn(), getAgentRun: vi.fn(), getRunTimeline: vi.fn(), cancelAgentRun: vi.fn(), retryAgentRun: vi.fn() }));
const conversationsService = vi.hoisted(() => ({ listConversations: vi.fn() }));

vi.mock('@/lib/services/agent-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agent-runs')>();
  return { ...actual, ...runsService };
});
vi.mock('@/lib/services/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/conversations')>();
  return { ...actual, ...conversationsService };
});

const CONVERSATIONS = {
  data: [
    { id: 'conv-1', title: '选题讨论', projectId: null, createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T02:00:00.000Z' },
    { id: 'conv-2', title: '第二会话', projectId: null, createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T01:00:00.000Z' },
  ],
  meta: { limit: 50, hasMore: false, order: 'desc', nextCursor: null, prevCursor: null },
};

type RunRow = Awaited<ReturnType<typeof import('@/lib/services/agent-runs').listAgentRuns>>['data'][number];

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 'run-abcdef12', userId: 'u1', agentId: 'agent-1', agentVersionId: 'ver-1', projectId: null,
    conversationId: 'conv-1', status: 'completed', currentStep: 3, maxSteps: 8, errorCode: null,
    errorMessage: null, metadata: null, createdAt: '2026-09-28T00:00:00.000Z',
    startedAt: '2026-09-28T00:00:01.000Z', completedAt: '2026-09-28T00:00:04.000Z', attempt: 1,
    retryOfRunId: null, parentRunId: null, agent: { slug: 'market-researcher', name: '市场研究员' },
    ...overrides,
  };
}

beforeEach(() => {
  runsService.listAgentRuns.mockReset();
  conversationsService.listConversations.mockReset();
  conversationsService.listConversations.mockResolvedValue(CONVERSATIONS);
});

describe('Agent 运行列表页', () => {
  it('未选会话：引导态（提示先选会话），且不发列表请求（conversationId 必填）', async () => {
    renderWithQuery(<AgentRunsPage />);
    expect(await screen.findByText('尚未选择会话')).toBeInTheDocument();
    // 会话选择器要等会话列表拉取完成才渲染（pending 时是 Skeleton）
    expect(await screen.findByRole('combobox', { name: '会话' })).toBeInTheDocument();
    expect(runsService.listAgentRuns).not.toHaveBeenCalled();
  });

  it('选择会话：按 conversationId 拉取并渲染行（状态/步骤/尝试/耗时）', async () => {
    runsService.listAgentRuns.mockResolvedValue({
      data: [
        run(),
        run({
          id: 'run-2', status: 'running', currentStep: 5, attempt: 2, retryOfRunId: 'run-abcdef12',
          completedAt: null, agent: { slug: 'topic-helper', name: '选题助手' },
        }),
      ],
    });
    renderWithQuery(<AgentRunsPage />);

    fireEvent.change(await screen.findByRole('combobox', { name: '会话' }), { target: { value: 'conv-2' } });

    await waitFor(() => expect(runsService.listAgentRuns).toHaveBeenCalledWith('conv-2'));
    expect(await screen.findByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('执行中')).toBeInTheDocument();
    // 每行按自己的 run.agent 投影（不共用同一份渲染）
    expect(screen.getByText('市场研究员（market-researcher）')).toBeInTheDocument();
    expect(screen.getByText('选题助手（topic-helper）')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getByText('3/8')).toBeInTheDocument();
    expect(within(table).getByText('5/8')).toBeInTheDocument();
    expect(within(table).getByText('（重试）')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'run-abcd' })).toHaveAttribute('href', '/agent-runs/run-abcdef12');
  });

  it('空结果：TableEmpty 空态', async () => {
    runsService.listAgentRuns.mockResolvedValue({ data: [] });
    renderWithQuery(<AgentRunsPage />);
    fireEvent.change(await screen.findByRole('combobox', { name: '会话' }), { target: { value: 'conv-1' } });
    expect(await screen.findByText('该会话暂无 Agent 运行')).toBeInTheDocument();
  });

  it('列表错误：错误横幅 + 重试按钮重新拉取', async () => {
    runsService.listAgentRuns.mockRejectedValueOnce(new ApiError('INTERNAL', '服务异常'));
    renderWithQuery(<AgentRunsPage />);
    fireEvent.change(await screen.findByRole('combobox', { name: '会话' }), { target: { value: 'conv-1' } });
    expect(await screen.findByText(/运行列表加载失败：服务异常/)).toBeInTheDocument();

    runsService.listAgentRuns.mockResolvedValue({ data: [run()] });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('已完成')).toBeInTheDocument();
  });

  it('会话列表失败：错误提示 + 重试；会话为空时给出引导文案', async () => {
    conversationsService.listConversations.mockRejectedValueOnce(new ApiError('INTERNAL', '会话服务异常'));
    const { unmount } = renderWithQuery(<AgentRunsPage />);
    expect(await screen.findByText(/会话列表加载失败：会话服务异常/)).toBeInTheDocument();
    unmount();

    conversationsService.listConversations.mockResolvedValue({ ...CONVERSATIONS, data: [] });
    renderWithQuery(<AgentRunsPage />);
    expect(await screen.findByText(/暂无可选会话/)).toBeInTheDocument();
  });
});
