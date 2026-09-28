import { Suspense } from 'react';
import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import EvaluationPage from '@/app/evaluation/page';
import EvaluationRunPage from '@/app/evaluation/runs/[runId]/page';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * M9-P1 评测 UI（只读）：
 * - 运行详情页的**事实呈现**：分数表（分母只计已出结果的 case）、case 输出与逐评测器结果（含证据原文）、
 *   baseline 对照（版本不同 → 明示不可比）；
 * - 列表页：数据集/运行/实验三块；
 * - 只读约束：本 UI 不发任何写请求（断言方法集合里没有 POST/PUT/PATCH/DELETE）。
 */

const RUN_DETAIL = {
  run: {
    id: 'run-1', datasetId: 'ds-1', datasetVersion: 1, agentId: 'ag-1', agentVersionId: 'av-1',
    status: 'running', totalCases: 3, completedCases: 2, baselineRunId: 'run-0',
    configSnapshot: { schema: 1, modelId: 'mock-echo', temperature: 0.7 },
    createdAt: '2026-09-28T00:00:00.000Z', completedAt: null,
  },
  cases: [
    {
      id: 'cr-1', caseId: 'c-1', status: 'completed', input: '问题一', output: { text: '回答一' },
      latencyMs: 12, promptTokens: 4, completionTokens: 5, cost: 0.000048, toolCalls: null, errorCode: null,
      case: { id: 'c-1', input: '问题一', expected: '回答一' },
      results: [
        { evaluatorId: 'ev-1', score: 1, passed: true, evidence: { matchMode: 'equals', comparedAs: 'text' } },
        { evaluatorId: 'ev-2', score: 0, passed: false, evidence: { parseError: '未在 judge 输出中找到 JSON 对象', raw: '[mock] 收到你的消息' } },
      ],
    },
    {
      id: 'cr-2', caseId: 'c-2', status: 'completed', input: '问题二', output: { text: '回答二' },
      latencyMs: 9, promptTokens: 4, completionTokens: 5, cost: 0.000048, toolCalls: [{ name: 'image.generate', arguments: '{}', output: null }], errorCode: null,
      case: { id: 'c-2', input: '问题二', expected: null },
      results: [{ evaluatorId: 'ev-1', score: 0, passed: false, evidence: { comparedAs: 'json' } }],
    },
  ],
  scores: {
    evaluators: [
      { evaluatorId: 'ev-1', name: '精确匹配', type: 'exact_match', evaluated: 2, passed: 1, failed: 1, avgScore: 0.5, passRate: 0.5 },
      { evaluatorId: 'ev-2', name: '判官', type: 'llm_judge', evaluated: 1, passed: 0, failed: 1, avgScore: 0, passRate: 0 },
    ],
    overall: { evaluated: 3, passed: 1, failed: 2, avgScore: 0.333333, passRate: 0.333333 },
    caseRuns: { total: 3, completed: 2, failed: 0, pending: 1, skipped: 0 },
  },
};

const COMPARISON = {
  candidateRunId: 'run-1', baselineRunId: 'run-0', comparable: true,
  summary: { improved: 0, regressed: 1, unchangedPass: 1, unchangedFail: 2, added: 0, removed: 0 },
  cases: [
    { caseId: 'c-1', outcome: 'unchanged_pass', baseline: { score: 1, passed: true }, candidate: { score: 1, passed: true } },
    { caseId: 'c-2', outcome: 'regressed', baseline: { score: 1, passed: true }, candidate: { score: 0, passed: false } },
  ],
  evaluators: [{ evaluatorId: 'ev-1', name: '精确匹配', type: 'exact_match', delta: { avgScore: 0, passRate: 0 } }],
};

function mockApi(over: { detail?: unknown; comparison?: unknown | null; status?: number } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (over.status && over.status >= 400) return jsonResponse({ error: { code: 'NOT_FOUND', message: '不存在' } }, over.status);
    if (url.endsWith('/comparison')) return jsonResponse({ data: { comparison: over.comparison === undefined ? COMPARISON : over.comparison } });
    if (url.includes('/evaluation/runs/')) return jsonResponse({ data: over.detail ?? RUN_DETAIL });
    throw new Error(`未预期的请求：${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderRunPage() {
  await act(async () => {
    renderWithQuery(
      <Suspense fallback={<p>页面加载中…</p>}>
        <EvaluationRunPage params={Promise.resolve({ runId: 'run-1' })} />
      </Suspense>,
    );
  });
  await screen.findByRole('heading', { name: '评测运行' });
}

describe('评测运行详情页（只读事实呈现）', () => {
  it('分数表逐评测器 + 总体；case 计数如实展示未跑完的部分', async () => {
    mockApi();
    await renderRunPage();
    const table = screen.getByRole('table');
    // 逐评测器行
    expect(within(table).getByText('精确匹配')).toBeInTheDocument();
    expect(within(table).getByText('exact_match')).toBeInTheDocument();
    expect(within(table).getByText('llm_judge')).toBeInTheDocument();
    expect(within(table).getByText('50%')).toBeInTheDocument(); // ev-1 通过率
    // 总体行（分母 3 = 已出结果数）
    const overall = within(table).getAllByRole('row').at(-1)!;
    expect(overall).toHaveTextContent('总体');
    expect(overall).toHaveTextContent('33.33%');
    // case 计数：completed 2 / pending 1 如实呈现（不把未跑完算成完成）
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText(/case：2\/3/)).toBeInTheDocument();
    expect(screen.getByText(/pending 1/)).toBeInTheDocument();
    expect(screen.getByText(/分母只计已出结果的 case/)).toBeInTheDocument();
  });

  it('case 事实：输入/期望/输出/tokens 成本/逐评测器通过态 + 证据原文可展开', async () => {
    mockApi();
    await renderRunPage();
    expect(screen.getByText('输入：问题一')).toBeInTheDocument();
    expect(screen.getByText('期望：回答一')).toBeInTheDocument();
    expect(screen.getByText('输出：回答一')).toBeInTheDocument();
    expect(screen.getByText(/12ms · 4\+5 tokens/)).toBeInTheDocument();
    // 逐评测器通过态（表格表头也有“通过”二字 → 限定在用例结果区块里断言）
    const caseSection = screen.getByRole('heading', { name: '用例结果（2）' }).closest('section')!;
    expect(within(caseSection).getByText('通过')).toBeInTheDocument();
    expect(within(caseSection).getAllByText('未通过')).toHaveLength(2);
    expect(screen.getByText(/未在 judge 输出中找到 JSON 对象/)).toBeInTheDocument();
    // 判官解析失败 → 证据里保留原文（可审计），绝不隐藏
    expect(screen.getByText(/未在 judge 输出中找到 JSON 对象/)).toBeInTheDocument();
    expect(screen.getAllByText('证据').length).toBeGreaterThanOrEqual(2);
    // 未定义 expected 的 case：不渲染“期望”行（绝不编造期望值）——两个 case 只有 1 行“期望”
    expect(screen.getAllByText(/^期望：/)).toHaveLength(1);
    expect(screen.getByText(/9ms · 4\+5 tokens/)).toBeInTheDocument();
  });

  it('baseline 对照：逐 case outcome + 汇总计数；不同版本时明示不可比', async () => {
    mockApi({ comparison: COMPARISON });
    await renderRunPage();
    expect(screen.getByText('基线对照')).toBeInTheDocument();
    expect(screen.getByText('unchangedPass 1')).toBeInTheDocument();
    expect(screen.getByText('regressed 1')).toBeInTheDocument();
    expect(screen.getAllByText('基线 通过（1）')).toHaveLength(2);
    expect(screen.getByText('→ 本次 通过（1）')).toBeInTheDocument();
    expect(screen.getByText('→ 本次 未通过（0）')).toBeInTheDocument();
    expect(screen.queryByText(/两侧数据集版本不同/)).not.toBeInTheDocument();
  });

  it('跨版本对照：显示“不可比”提示（绝不伪造可比性）', async () => {
    mockApi({ comparison: { ...COMPARISON, comparable: false } });
    await renderRunPage();
    expect(screen.getByText(/两侧数据集版本不同 → 不可比/)).toBeInTheDocument();
  });

  it('无基线：comparison=null 时不渲染对照区块', async () => {
    mockApi({ comparison: null });
    await renderRunPage();
    expect(screen.queryByText('基线对照')).not.toBeInTheDocument();
  });

  it('加载失败：整页错误态', async () => {
    mockApi({ status: 404 });
    await act(async () => {
      renderWithQuery(
        <Suspense fallback={<p>页面加载中…</p>}>
          <EvaluationRunPage params={Promise.resolve({ runId: 'run-x' })} />
        </Suspense>,
      );
    });
    expect(await screen.findByText('评测运行加载失败')).toBeInTheDocument();
  });

  it('只读约束：页面渲染全程只发 GET（写路径必须走带 RBAC 的独立入口）', async () => {
    const fetchMock = mockApi();
    await renderRunPage();
    const methods = fetchMock.mock.calls.map((c) => ((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase());
    expect(methods.every((m) => m === 'GET')).toBe(true);
  });
});

const DATASETS = [{
  id: 'ds-1', name: '问题集', description: '回归用例', version: 2, caseCount: 3, runCount: 2,
  updatedAt: '2026-09-28T00:00:00.000Z',
}];
const RUNS = [{
  id: 'run-1', datasetId: 'ds-1', datasetVersion: 1, agentVersionId: 'av-1', status: 'completed',
  totalCases: 3, completedCases: 3, baselineRunId: null, createdAt: '2026-09-28T00:00:00.000Z', completedAt: '2026-09-28T00:01:00.000Z',
}];
const EXPERIMENTS = [{ id: 'exp-1', name: '上下文跟随实验', status: 'running', variantCount: 2, createdAt: '2026-09-28T00:00:00.000Z' }];

describe('评测列表页（数据集 / 运行 / 实验）', () => {
  it('三块如实渲染，并链到数据集与运行详情', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/evaluation/datasets')) return jsonResponse({ data: { datasets: DATASETS } });
      if (url.includes('/evaluation/runs')) return jsonResponse({ data: { runs: RUNS } });
      if (url.includes('/evaluation/experiments')) return jsonResponse({ data: { experiments: EXPERIMENTS } });
      throw new Error(`未预期的请求：${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWithQuery(<EvaluationPage />);
    await screen.findByRole('heading', { name: '评测' });

    expect(screen.getByText('问题集')).toBeInTheDocument();
    expect(screen.getByText(/v2 · 3 用例 · 2 次评测/)).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText(/v1 · 3\/3 case/)).toBeInTheDocument();
    expect(screen.getByText('上下文跟随实验')).toBeInTheDocument();
    expect(screen.getByText(/绝不下发线上流量/)).toBeInTheDocument();

    expect(screen.getByRole('link', { name: /问题集/ })).toHaveAttribute('href', '/evaluation/datasets/ds-1');
    expect(screen.getByRole('link', { name: /run-1/ })).toHaveAttribute('href', '/evaluation/runs/run-1');
  });

  it('空列表不报错（无数据集/运行/实验时给出空态）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/evaluation/datasets')) return jsonResponse({ data: { datasets: [] } });
      if (url.includes('/evaluation/runs')) return jsonResponse({ data: { runs: [] } });
      return jsonResponse({ data: { experiments: [] } });
    }));
    renderWithQuery(<EvaluationPage />);
    await screen.findByRole('heading', { name: '评测' });
    expect(screen.getByText('暂无数据集')).toBeInTheDocument();
    expect(screen.getByText('暂无运行')).toBeInTheDocument();
    expect(screen.getByText('暂无实验')).toBeInTheDocument();
  });
});
