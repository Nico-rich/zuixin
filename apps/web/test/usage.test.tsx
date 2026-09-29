import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import UsagePage from '@/app/usage/page';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * /usage（M13-W6）——Run 级用量：会话 → Agent 运行 → UsageRecord 聚合视图。
 *
 * 契约：
 *  ① 列表端点要求 conversationId 必填 → 页面必须两步定位（未选会话时 run 选择禁用、不发请求）；
 *  ② 选中会话后自动落到该会话第一个 run（不隐式跨会话取数），切会话即切 run 并重新取用量；
 *  ③ 用量数字全部来自服务端响应，页面只做展示格式化（token 千分位、金额精度、时长分档）；
 *  ④ 无会话/该会话无运行/未选择 三种空态各自明确，绝不停在「加载中…」。
 */

const at = (y: number, m: number, d: number, h = 10, min = 30) => new Date(y, m, d, h, min).toISOString();

const CONVERSATIONS = [
  { id: 'c-1', title: '生图实验', projectId: null, createdAt: at(2026, 8, 28), updatedAt: at(2026, 8, 29, 11, 20) },
  { id: 'c-2', title: '文案迭代', projectId: null, createdAt: at(2026, 8, 27), updatedAt: at(2026, 8, 28, 9, 0) },
];

const RUN_1 = {
  id: 'run-1', userId: 'u-1', agentId: 'ag-1', agentVersionId: 'av-1', projectId: null, conversationId: 'c-1',
  status: 'completed', currentStep: 3, maxSteps: 10, errorCode: null, errorMessage: null, metadata: null,
  createdAt: at(2026, 8, 29, 11, 0), startedAt: at(2026, 8, 29, 11, 0), completedAt: at(2026, 8, 29, 11, 2),
  attempt: 1, retryOfRunId: null, parentRunId: null,
};
const RUN_2 = { ...RUN_1, id: 'run-2', status: 'failed', createdAt: at(2026, 8, 29, 10, 0), errorCode: 'MODEL_ERROR' };
const RUN_C2 = { ...RUN_1, id: 'run-3', conversationId: 'c-2', status: 'running' };

/** 自洽的聚合：totalTokens = input + output；totalCost = llm + image + video */
const USAGE_1 = {
  runId: 'run-1',
  durationMs: 125000,
  totalTokens: 1300,
  inputTokens: 1234,
  outputTokens: 66,
  llmCost: 1.19,
  imageCost: 0.034,
  videoCost: 0,
  totalCost: 1.224,
  llmRounds: 3,
  imageCount: 1,
  videoSeconds: 12.5,
  failedCalls: 1,
  byKind: [
    { kind: 'llm_chat', count: 3, cost: 1.19, tokens: 1300 },
    { kind: 'image_generation', count: 1, cost: 0.034, tokens: 0 },
  ],
};

const USAGE_2 = {
  ...USAGE_1, runId: 'run-2', totalTokens: 120, inputTokens: 100, outputTokens: 20,
  llmCost: 0.5, imageCost: 0, totalCost: 0.5, durationMs: 800, llmRounds: 1, imageCount: 0,
  videoSeconds: 0, failedCalls: 1, byKind: [{ kind: 'llm_chat', count: 1, cost: 0.5, tokens: 120 }],
};

type FetchCall = [RequestInfo | URL, RequestInit | undefined];

function mockApi(options: { conversations?: unknown[] } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/v1/conversations')) return jsonResponse({ data: options.conversations ?? CONVERSATIONS });
    if (url.includes('/api/v1/agent-runs?')) {
      const conversationId = new URL(url, 'http://localhost').searchParams.get('conversationId');
      if (conversationId === 'c-1') return jsonResponse({ data: [RUN_1, RUN_2] });
      if (conversationId === 'c-2') return jsonResponse({ data: [RUN_C2] });
      return jsonResponse({ data: [] });
    }
    if (url.includes('/api/v1/usage/agent-runs/run-1')) return jsonResponse({ data: USAGE_1 });
    if (url.includes('/api/v1/usage/agent-runs/run-2')) return jsonResponse({ data: USAGE_2 });
    if (url.includes('/api/v1/usage/agent-runs/run-3')) return jsonResponse({ data: { ...USAGE_2, runId: 'run-3' } });
    throw new Error(`未预期的请求：${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage(options: Parameters<typeof mockApi>[0] = {}) {
  const fetchMock = mockApi(options);
  renderWithQuery(<UsagePage />);
  await screen.findByRole('heading', { name: '用量' });
  return fetchMock;
}

async function pickConversation(id: string) {
  fireEvent.change(screen.getByLabelText('会话'), { target: { value: id } });
  await waitFor(() => expect(screen.getByLabelText('Agent 运行')).not.toBeDisabled());
}

const urlsOf = (fetchMock: ReturnType<typeof mockApi>) => (fetchMock.mock.calls as unknown as FetchCall[]).map(([url]) => String(url));

describe('Usage 页面 · 两步定位（会话 → 运行）', () => {
  it('未选会话：运行选择禁用、不发 runs/usage 请求，并给出明确引导', async () => {
    const fetchMock = await renderPage();
    await screen.findByRole('option', { name: /生图实验/ });
    expect(screen.getByLabelText('Agent 运行')).toBeDisabled();
    expect(screen.getByText('请选择会话与运行以查看用量。')).toBeInTheDocument();
    expect(urlsOf(fetchMock).some((url) => url.includes('/agent-runs?'))).toBe(false);
    expect(urlsOf(fetchMock).some((url) => url.includes('/api/v1/usage/'))).toBe(false);
  });

  it('会话选项带标题与更新时间（列表端点 limit=20）', async () => {
    const fetchMock = await renderPage();
    const option = await screen.findByRole('option', { name: /生图实验 · 2026-09-29 11:20/ });
    expect(option).toHaveValue('c-1');
    expect(urlsOf(fetchMock).some((url) => url.includes('/api/v1/conversations?limit=20'))).toBe(true);
  });

  it('选中会话后自动落到该会话第一个 run 并取回用量（conversationId 必填参数如实拼装）', async () => {
    const fetchMock = await renderPage();
    await screen.findByRole('option', { name: /生图实验/ });
    await pickConversation('c-1');

    await waitFor(() => {
      expect(urlsOf(fetchMock).some((url) => url.includes('/api/v1/agent-runs?conversationId=c-1'))).toBe(true);
      expect(urlsOf(fetchMock).some((url) => url.includes('/api/v1/usage/agent-runs/run-1'))).toBe(true);
    });
    expect(screen.getByLabelText('Agent 运行')).toHaveValue('run-1');
    expect(await screen.findByText('run-1')).toBeInTheDocument();
  });

  it('切换会话：按新 conversationId 重新取 runs，并自动切到该会话的 run（不跨会话复用旧选择）', async () => {
    const fetchMock = await renderPage();
    await screen.findByRole('option', { name: /生图实验/ });
    await pickConversation('c-1');
    await screen.findByText('run-1');

    await pickConversation('c-2');
    await waitFor(() => {
      expect(urlsOf(fetchMock).some((url) => url.includes('/api/v1/agent-runs?conversationId=c-2'))).toBe(true);
      expect(urlsOf(fetchMock).some((url) => url.includes('/api/v1/usage/agent-runs/run-3'))).toBe(true);
    });
    expect(screen.getByLabelText('Agent 运行')).toHaveValue('run-3');
  });
});

describe('Usage 页面 · 用量呈现（token / 成本 / 媒体 / 时长）', () => {
  it('token 千分位、金额按量级精度（小额不被抹成 $0.00）、时长分档', async () => {
    await renderPage();
    await screen.findByRole('option', { name: /生图实验/ });
    await pickConversation('c-1');
    const usage = within(await screen.findByTestId('run-usage'));

    expect(await usage.findByText('1,234')).toBeInTheDocument();          // inputTokens
    expect(usage.getByText('66')).toBeInTheDocument();                    // outputTokens
    expect(usage.getAllByText('1,300')).toHaveLength(2);                  // 合计卡 + llm_chat 行
    expect(usage.getByText('$1.22')).toBeInTheDocument();                 // totalCost（>=1 → 2 位）
    expect(usage.getAllByText('$1.19')).toHaveLength(2);                  // llmCost 卡 + llm_chat 行
    expect(usage.getAllByText('$0.034')).toHaveLength(2);                 // imageCost 卡 + 行（4 位精度）
    expect(usage.getByText('$0')).toBeInTheDocument();                    // videoCost = 0
    expect(usage.getByText('2m 5s')).toBeInTheDocument();                 // durationMs 125000
    expect(usage.getByText('12.5')).toBeInTheDocument();                  // videoSeconds（非整数）
    expect(usage.getByText('事实')).toBeInTheDocument();
    expect(usage.getByText('UsageRecord 聚合')).toBeInTheDocument();
  });

  it('byKind 明细逐行呈现（类型 / 次数 / token / 成本），数字与行内对应', async () => {
    await renderPage();
    await screen.findByRole('option', { name: /生图实验/ });
    await pickConversation('c-1');
    const usage = within(await screen.findByTestId('run-usage'));
    await usage.findByText('llm_chat');

    const llmRow = within(usage.getByText('llm_chat').closest('tr')!);
    expect(llmRow.getByText('3')).toBeInTheDocument();
    expect(llmRow.getByText('1,300')).toBeInTheDocument();
    expect(llmRow.getByText('$1.19')).toBeInTheDocument();

    const imageRow = within(usage.getByText('image_generation').closest('tr')!);
    expect(imageRow.getByText('$0.034')).toBeInTheDocument();
    expect(imageRow.getByText('0')).toBeInTheDocument(); // 该类型无 token
  });

  it('可手动切换运行：用量随选中 run 变化（旧值不残留）', async () => {
    await renderPage();
    await screen.findByRole('option', { name: /生图实验/ });
    await pickConversation('c-1');
    await screen.findByText('$1.22');

    fireEvent.change(screen.getByLabelText('Agent 运行'), { target: { value: 'run-2' } });
    const usage = within(await screen.findByTestId('run-usage'));
    // run-2 的 totalCost/llmCost 与 llm_chat 行成本同为 0.5 → 断言「出现」而不占用例唯一性
    await waitFor(() => expect(usage.getAllByText('$0.5').length).toBeGreaterThan(0));
    expect(usage.getByText('800ms')).toBeInTheDocument();
    expect(usage.queryByText('$1.22')).toBeNull();
  });
});

describe('Usage 页面 · 空态', () => {
  it('没有任何会话：给出「先到对话创建」的引导', async () => {
    await renderPage({ conversations: [] });
    expect(await screen.findByText(/暂无会话——先到「对话」创建会话并触发一次 Agent 运行。/)).toBeInTheDocument();
  });

  it('会话存在但该会话无运行：明确空态且不发 usage 请求', async () => {
    const fetchMock = await renderPage({ conversations: [{ ...CONVERSATIONS[0], id: 'c-9', title: '空会话' }] });
    await screen.findByRole('option', { name: /空会话/ });
    // 该会话无运行 → run 选择保持禁用（不能用 pickConversation 等待「启用」）
    fireEvent.change(screen.getByLabelText('会话'), { target: { value: 'c-9' } });
    await waitFor(() => expect(screen.getByRole('option', { name: '该会话暂无运行' })).toBeInTheDocument());

    expect(await screen.findByText('该会话暂无 Agent 运行。')).toBeInTheDocument();
    expect(screen.getByText('请选择会话与运行以查看用量。')).toBeInTheDocument();
    expect(urlsOf(fetchMock).some((url) => url.includes('/api/v1/usage/'))).toBe(false);
  });
});
