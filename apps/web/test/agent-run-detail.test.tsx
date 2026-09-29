import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import AgentRunDetailPage from '@/app/agent-runs/[id]/page';
import { ToastProvider } from '@/components/ui/toast';
import { renderWithQuery } from './helpers';

/**
 * Agent 运行详情（M13-W2）：
 * - 状态/时间/错误码来自 `getAgentRun`；用量来自 `getRunTimeline`（detail 不含 usage）；
 * - cancel/retry 严格按后端 409 语义禁用（终态不可终止、非终态不可重试），写操作用 useApiMutation + Toast；
 * - retry 成功后跳到新运行（后端幂等返回 runId）；
 * - 时间线复用既有 chat 组件（执行详情折叠面板）。
 */
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({ id: 'run-1' }),
  usePathname: () => '/agent-runs/run-1',
  useSearchParams: () => new URLSearchParams(),
}));

const service = vi.hoisted(() => ({ listAgentRuns: vi.fn(), getAgentRun: vi.fn(), getRunTimeline: vi.fn(), cancelAgentRun: vi.fn(), retryAgentRun: vi.fn() }));
vi.mock('@/lib/services/agent-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agent-runs')>();
  return { ...actual, ...service };
});

type RunDetail = Awaited<ReturnType<typeof import('@/lib/services/agent-runs').getAgentRun>>['data'];
type Timeline = Awaited<ReturnType<typeof import('@/lib/services/agent-runs').getRunTimeline>>['data'];

function detail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: 'run-1', userId: 'u1', agentId: 'agent-1', agentVersionId: 'ver-1', projectId: null,
    conversationId: 'conv-1', status: 'completed', currentStep: 3, maxSteps: 8, errorCode: null,
    errorMessage: null, metadata: null, createdAt: '2026-09-28T00:00:00.000Z',
    startedAt: '2026-09-28T00:00:01.000Z', completedAt: '2026-09-28T00:00:04.000Z', attempt: 1,
    retryOfRunId: null, parentRunId: null,
    agent: { id: 'agent-1', slug: 'market-researcher', name: '市场研究员' },
    agentVersion: { id: 'ver-1', version: 2, status: 'published' },
    steps: [
      { id: 'st-1', runId: 'run-1', stepIndex: 1, type: 'llm', status: 'completed', createdAt: '2026-09-28T00:00:01.000Z', completedAt: '2026-09-28T00:00:02.000Z', toolCalls: [] },
      { id: 'st-2', runId: 'run-1', stepIndex: 2, type: 'tool', status: 'completed', createdAt: '2026-09-28T00:00:02.000Z', completedAt: '2026-09-28T00:00:03.000Z', toolCalls: [{ id: 'tc-1', runId: 'run-1', name: 'knowledge.search', status: 'completed', input: null, output: null, errorCode: null, createdAt: '2026-09-28T00:00:02.000Z', completedAt: '2026-09-28T00:00:03.000Z' }] },
    ],
    tasks: [],
    artifacts: [],
    ...overrides,
  };
}

function timeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    runId: 'run-1', agentId: 'agent-1', agentName: '市场研究员', agentVersion: 2, status: 'completed',
    startedAt: '2026-09-28T00:00:01.000Z', completedAt: '2026-09-28T00:00:04.000Z',
    items: [
      { id: 'it-1', type: 'run.started', status: 'info', timestamp: '2026-09-28T00:00:01.000Z', title: '开始执行' },
      { id: 'it-2', type: 'tool.completed', status: 'success', timestamp: '2026-09-28T00:00:03.000Z', title: '工具完成', summary: 'knowledge.search', durationMs: 900 },
    ],
    usage: {
      runId: 'run-1', durationMs: 3000, totalTokens: 1500, inputTokens: 1000, outputTokens: 500,
      llmCost: 0.05, imageCost: 0.04, videoCost: 0, totalCost: 0.09, llmRounds: 2,
      imageCount: 1, videoSeconds: 0, failedCalls: 1,
      byKind: [{ kind: 'llm_chat', count: 2, cost: 0.05, tokens: 1500 }, { kind: 'image', count: 1, cost: 0.04, tokens: 0 }],
    },
    ...overrides,
  };
}

/** Toast 由 AppShell 全局挂载（页面单测默认无 Provider → useToast 是 no-op），这里显式包一层 */
function renderPage() {
  return renderWithQuery(<ToastProvider><AgentRunDetailPage /></ToastProvider>);
}

async function renderDetail(runDetail: RunDetail = detail(), runTimeline: Timeline = timeline()) {
  service.getAgentRun.mockResolvedValue({ data: runDetail });
  service.getRunTimeline.mockResolvedValue({ data: runTimeline });
  renderPage();
  await screen.findByRole('heading', { name: '运行详情' });
}

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset();
  pushMock.mockReset();
});

describe('Agent 运行详情：投影呈现', () => {
  it('渲染状态/时间/步骤血缘/错误码，并复用 chat 时间线组件', async () => {
    await renderDetail(detail({ status: 'failed', errorCode: 'LLM_ERROR', errorMessage: '上游超时' }));

    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('第 1 次尝试')).toBeInTheDocument();
    expect(screen.getByText('步骤 3/8')).toBeInTheDocument();
    expect(screen.getByText('失败原因：LLM_ERROR')).toBeInTheDocument();
    expect(screen.getByText('上游超时')).toBeInTheDocument();
    // 头部描述行是「Agent · 版本 · 会话」拼成的一段文本 → 用正则匹配子串
    expect(screen.getByText(/市场研究员（market-researcher）/)).toBeInTheDocument();

    const stepsTable = screen.getByText('tool').closest('table')!;
    expect(within(stepsTable).getByText('llm')).toBeInTheDocument();
    expect(within(stepsTable).getAllByText('completed')).toHaveLength(2); // 两步都在表内投影

    // 复用既有 chat 组件的折叠面板（不复制一份渲染逻辑）
    expect(screen.getByRole('button', { name: /执行详情/ })).toBeInTheDocument();
  });

  it('用量：token / 成本 / 媒体用量 / 分类型表（来自 timeline 的 usage 聚合）', async () => {
    await renderDetail();

    expect(screen.getByText('总 token')).toBeInTheDocument();
    // 指标值取相邻兄弟节点（避免千分位分隔符与其它单元格文本撞车）
    expect(screen.getByText('总 token').nextElementSibling).toHaveTextContent(/1[,.]500/);
    expect(screen.getByText('LLM 轮次').nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText('合计估算').nextElementSibling).toHaveTextContent('$0.0900');
    expect(screen.getByText('1 张 · $0.0400')).toBeInTheDocument();    // 图片张数 + 图片成本

    const usageTable = screen.getByText('llm_chat').closest('table')!;
    expect(within(usageTable).getByText('image')).toBeInTheDocument();
    expect(within(usageTable).getByText('$0.0500')).toBeInTheDocument();
    expect(within(usageTable).getByText('$0.0400')).toBeInTheDocument();
  });

  it('无用量记录：明确文案（而不是编造 0 值表格）', async () => {
    const parsed = timeline();
    parsed.usage = null;
    await renderDetail(detail(), parsed);
    expect(screen.getByText(/该运行没有用量记录/)).toBeInTheDocument();
  });

  it('时间线加载失败：错误横幅 + 重试（详情其余部分仍可用）', async () => {
    service.getAgentRun.mockResolvedValue({ data: detail() });
    service.getRunTimeline.mockRejectedValueOnce(new ApiError('INTERNAL', '投影失败'));
    renderPage();
    expect(await screen.findByText(/时间线\/用量加载失败：投影失败/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /执行详情/ })).toBeInTheDocument();
  });

  it('详情 404：明确错误 + 重试', async () => {
    service.getAgentRun.mockRejectedValue(new ApiError('NOT_FOUND', '运行不存在'));
    renderPage();
    expect(await screen.findByText(/运行详情加载失败：运行不存在/)).toBeInTheDocument();
  });
});

describe('Agent 运行详情：终止与重试（后端 409 语义一致）', () => {
  it('终态：终止禁用、重试可点；重试成功跳到新运行', async () => {
    service.retryAgentRun.mockResolvedValue({ data: { runId: 'run-2', status: 'queued', attempt: 2, retryOfRunId: 'run-1' } });
    await renderDetail();

    expect(screen.getByRole('button', { name: '终止本次执行' })).toBeDisabled();
    expect(screen.getByText('终态：可重试，不可终止')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试本次执行' }));
    await waitFor(() => expect(service.retryAgentRun).toHaveBeenCalledWith('run-1'));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/agent-runs/run-2'));
  });

  it('非终态：终止可点（成功给出反馈），重试禁用', async () => {
    service.cancelAgentRun.mockResolvedValue({ data: { runId: 'run-1', status: 'cancelled' } });
    await renderDetail(detail({ status: 'running', completedAt: null }));

    expect(screen.getByRole('button', { name: '重试本次执行' })).toBeDisabled();
    expect(screen.getByText('执行中：可终止，不可重试')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '终止本次执行' }));
    await waitFor(() => expect(service.cancelAgentRun).toHaveBeenCalledWith('run-1'));
    expect(await screen.findByText('已请求终止该运行')).toBeInTheDocument();
  });

  it('终止失败（已终态 409）：Toast 呈现后端错误码语义，不改变页面状态', async () => {
    service.cancelAgentRun.mockRejectedValue(new ApiError('RUN_NOT_CANCELLABLE', '运行已结束，无法终止'));
    await renderDetail(detail({ status: 'waiting', completedAt: null }));

    fireEvent.click(screen.getByRole('button', { name: '终止本次执行' }));
    expect(await screen.findByText('终止失败')).toBeInTheDocument();
    expect(screen.getByText('运行已结束，无法终止')).toBeInTheDocument();
  });
});
