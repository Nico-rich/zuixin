import { Suspense } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import EvaluationPage from '@/app/evaluation/page';
import EvaluationDatasetPage from '@/app/evaluation/datasets/[id]/page';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * M13-W10：evaluation 写面最小集（后端 M9-P1 已就绪，全部受 evaluation.write = owner/admin 守卫）。
 *  - 建数据集（POST /evaluation/datasets）
 *  - 发起评测运行（POST /evaluation/runs，datasetId + agentVersionId + evaluatorIds，strictObject 不接受多余字段）
 *  - 取消运行（POST /evaluation/runs/:id/cancel，仅 pending/running）
 *  - 建实验（POST /evaluation/experiments，hypothesis 必须是 JSON 对象）
 *  - 数据集写入用例（PUT /evaluation/datasets/:id/cases —— **整批替换**语义，copy-on-write）
 * 权限不隐藏入口：403 一律渲染权限徽标（服务端是唯一裁决方）。
 */

const DATASETS = [
  { id: 'ds-1', name: '问题集', description: '回归用例', version: 2, caseCount: 3, runCount: 2, updatedAt: '2026-09-29T00:00:00.000Z' },
];
const RUNS = [
  { id: 'run-1', datasetId: 'ds-1', datasetVersion: 2, agentVersionId: 'av-0', status: 'running', totalCases: 3, completedCases: 1, baselineRunId: null, createdAt: '2026-09-29T00:00:00.000Z', completedAt: null },
  { id: 'run-2', datasetId: 'ds-1', datasetVersion: 1, agentVersionId: 'av-1', status: 'completed', totalCases: 3, completedCases: 3, baselineRunId: null, createdAt: '2026-09-29T00:00:00.000Z', completedAt: '2026-09-29T00:01:00.000Z' },
];
const EXPERIMENTS = [{ id: 'exp-1', name: '上下文跟随实验', status: 'draft', variantCount: 0, createdAt: '2026-09-29T00:00:00.000Z' }];
const EVALUATORS = [
  { id: 'ev-1', name: '精确匹配', type: 'exact_match' },
  { id: 'ev-2', name: '判官', type: 'llm_judge' },
];

const writeCall = (fetchMock: ReturnType<typeof vi.fn>, method: string) =>
  fetchMock.mock.calls.find((c) => ((c[1] as RequestInit)?.method ?? 'GET') === method);

function mockListApi(over: { write?: (url: string, method: string) => Response | null } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      const custom = over.write?.(url, method);
      if (custom) return custom;
      return jsonResponse({ data: { id: 'created-1', name: '新对象', status: 'draft', variantCount: 0, version: 1, caseCount: 0, runCount: 0, datasetVersion: 1, totalCases: 0, completedCases: 0 } });
    }
    if (url.includes('/evaluation/datasets')) return jsonResponse({ data: { datasets: DATASETS } });
    if (url.includes('/evaluation/evaluators')) return jsonResponse({ data: { evaluators: EVALUATORS } });
    if (url.includes('/evaluation/runs')) return jsonResponse({ data: { runs: RUNS } });
    if (url.includes('/evaluation/experiments')) return jsonResponse({ data: { experiments: EXPERIMENTS } });
    return jsonResponse({ data: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderList() {
  renderWithQuery(<EvaluationPage />);
  await screen.findByText('问题集');
  await screen.findByText('上下文跟随实验');
}

describe('EvaluationPage：建数据集 / 发起运行 / 取消 / 建实验', () => {
  it('建数据集：POST /evaluation/datasets（description 为空则不提交该字段）', async () => {
    const fetchMock = mockListApi();
    await renderList();
    fireEvent.click(screen.getByRole('button', { name: '新建数据集' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新数据集' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }));
      await Promise.resolve();
    });
    const post = writeCall(fetchMock, 'POST')!;
    expect(String(post[0])).toBe('/api/v1/evaluation/datasets');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ name: '新数据集' });
  });

  it('评测器列表懒加载：弹窗打开前不打 /evaluation/evaluators（列表页首屏保持 3 个只读请求）', async () => {
    const fetchMock = mockListApi();
    await renderList();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/evaluators'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '新建评测运行' }));
    await screen.findByRole('checkbox', { name: /精确匹配/ });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/evaluators'))).toBe(true);
  });

  it('发起运行：POST /evaluation/runs（datasetId/agentVersionId/evaluatorIds，不含其他字段）', async () => {
    const fetchMock = mockListApi();
    await renderList();
    fireEvent.click(screen.getByRole('button', { name: '新建评测运行' }));
    await screen.findByRole('checkbox', { name: /精确匹配/ });

    fireEvent.change(screen.getByLabelText('Agent 版本 ID（AgentVersion 不可变）'), { target: { value: 'av-2' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /精确匹配/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }));
      await Promise.resolve();
    });

    const post = writeCall(fetchMock, 'POST')!;
    expect(String(post[0])).toBe('/api/v1/evaluation/runs');
    // 服务端 DTO 是 strictObject：多一个字段就 400 —— 提交体必须只含已选字段
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ datasetId: 'ds-1', agentVersionId: 'av-2', evaluatorIds: ['ev-1'] });
  });

  it('发起运行：未选评测器时不提交 evaluatorIds（服务端语义 = 本次不打分，仍产出输出与成本）', async () => {
    const fetchMock = mockListApi();
    await renderList();
    fireEvent.click(screen.getByRole('button', { name: '新建评测运行' }));
    await screen.findByRole('checkbox', { name: /精确匹配/ });
    fireEvent.change(screen.getByLabelText('Agent 版本 ID（AgentVersion 不可变）'), { target: { value: 'av-2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }));
      await Promise.resolve();
    });
    expect(JSON.parse(String((writeCall(fetchMock, 'POST')![1] as RequestInit).body))).toEqual({ datasetId: 'ds-1', agentVersionId: 'av-2' });
  });

  it('取消运行：确认后 POST /evaluation/runs/:id/cancel（仅未结束的运行给入口）', async () => {
    const fetchMock = mockListApi();
    await renderList();
    expect(screen.getAllByRole('button', { name: '取消' })).toHaveLength(1); // run-2 已完成 → 无入口
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('取消评测运行');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '取消运行' }));
      await Promise.resolve();
    });
    expect(String(writeCall(fetchMock, 'POST')![0])).toBe('/api/v1/evaluation/runs/run-1/cancel');
  });

  it('建实验：hypothesis 提交为 JSON 对象；非法 JSON 与数组都在本地拦截', async () => {
    const fetchMock = mockListApi();
    await renderList();
    fireEvent.click(screen.getByRole('button', { name: '新建实验' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新实验' } });
    fireEvent.change(screen.getByLabelText('假设（JSON 对象，可选）'), { target: { value: '{不是 JSON' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }));
      await Promise.resolve();
    });
    expect(screen.getByText('hypothesis 必须是合法 JSON')).toBeInTheDocument();
    expect(writeCall(fetchMock, 'POST')).toBeUndefined();

    fireEvent.change(screen.getByLabelText('假设（JSON 对象，可选）'), { target: { value: '[1,2]' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }));
      await Promise.resolve();
    });
    expect(screen.getByText(/hypothesis 必须是 JSON 对象/)).toBeInTheDocument();
    expect(writeCall(fetchMock, 'POST')).toBeUndefined();

    fireEvent.change(screen.getByLabelText('假设（JSON 对象，可选）'), { target: { value: '{"期待":"更短"}' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }));
      await Promise.resolve();
    });
    const post = writeCall(fetchMock, 'POST')!;
    expect(String(post[0])).toBe('/api/v1/evaluation/experiments');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ name: '新实验', hypothesis: { 期待: '更短' } });
  });

  it('403（无 evaluation.write）：弹窗内渲染 owner/admin 权限徽标', async () => {
    mockListApi({ write: () => jsonResponse({ error: { code: 'FORBIDDEN', message: '权限不足' } }, 403) });
    await renderList();
    fireEvent.click(screen.getByRole('button', { name: '新建数据集' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新数据集' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }));
      await Promise.resolve();
    });
    expect(await screen.findByTestId('forbidden-badge')).toHaveTextContent('403 权限不足 · 需要组织 owner/admin 权限（evaluation.write）');
  });
});

/* ------------------------------ 数据集页：写入用例 ------------------------------ */

const CASE_ROWS = [
  { id: 'c-1', version: 2, input: '问题一', expected: '回答一', tags: ['smoke'], createdAt: '2026-09-29T00:00:00.000Z' },
  { id: 'c-2', version: 2, input: { message: '问题二' }, expected: null, tags: null, createdAt: '2026-09-29T00:00:00.000Z' },
];
type DatasetState = { id: string; name: string; description: string | null; version: number; cases: unknown[] };
let datasetState: DatasetState = { id: 'ds-1', name: '问题集', description: '回归用例', version: 2, cases: CASE_ROWS as unknown[] };

function mockDatasetApi(over: { put?: Response } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET') === 'PUT') {
      if (over.put) return over.put;
      const body = JSON.parse(String(init!.body)) as { cases: Array<{ input: string | { message: string }; expected?: unknown; tags?: string[] }> };
      const cases = body.cases.map((c, i) => ({
        id: `c-new-${i}`, version: 3, input: c.input, expected: c.expected ?? null, tags: c.tags ?? null, createdAt: '2026-09-29T01:00:00.000Z',
      }));
      datasetState = { ...datasetState, version: 3, cases };
      return jsonResponse({ data: datasetState });
    }
    if (url.includes('/versions')) {
      return jsonResponse({ data: { versions: [{ version: 2, caseCount: 2 }, { version: 3, caseCount: datasetState.cases.length }] } });
    }
    return jsonResponse({ data: datasetState });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderDataset() {
  await act(async () => {
    renderWithQuery(
      <Suspense fallback={<p>页面加载中…</p>}>
        <EvaluationDatasetPage params={Promise.resolve({ id: 'ds-1' })} />
      </Suspense>,
    );
  });
  await screen.findByRole('heading', { name: '问题集' });
}

describe('EvaluationDatasetPage：写入用例（整批替换语义）', () => {
  it('提交既有用例（原样回写，{message} 结构不被改写成字符串）+ 新增 1 条', async () => {
    datasetState = { id: 'ds-1', name: '问题集', description: '回归用例', version: 2, cases: CASE_ROWS };
    const fetchMock = mockDatasetApi();
    await renderDataset();
    fireEvent.click(screen.getByRole('button', { name: '写入用例' }));
    const dialog = await screen.findByRole('dialog');
    // 语义必须如实告知：这是整批替换（copy-on-write），不是增量追加
    expect(dialog).toHaveTextContent('整批替换');
    expect(dialog).toHaveTextContent('既有 2 条 + 新增 1 条');

    fireEvent.change(screen.getByLabelText('输入（必填，≤20000 字）'), { target: { value: '问题三' } });
    fireEvent.change(screen.getByLabelText('期望（可选，纯文本精确比较）'), { target: { value: '回答三' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '写入' }));
      await Promise.resolve();
    });

    const put = writeCall(fetchMock, 'PUT')!;
    expect(String(put[0])).toBe('/api/v1/evaluation/datasets/ds-1/cases');
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({
      cases: [
        { input: '问题一', expected: '回答一', tags: ['smoke'] },
        { input: { message: '问题二' }, expected: null }, // 结构原样保留（不许 stringify 成 '{"message":...}'）
        { input: '问题三', expected: '回答三' },
      ],
    });
    // 版本推进如实显示（v2 → v3）：以服务端返回 + 重新拉取后的事实为准
    await screen.findByText('问题三');
    expect(screen.getByText('当前版本用例（3）')).toBeInTheDocument();
    await screen.findByText('v3 · 3 用例');
  });

  it('存在无法原样回写的用例（input 非 string / {message}）→ 本地拦截，绝不改写历史用例', async () => {
    datasetState = { id: 'ds-1', name: '问题集', description: null, version: 2, cases: [{ id: 'c-x', version: 2, input: 42, expected: null, tags: null, createdAt: 'T' }] };
    const fetchMock = mockDatasetApi();
    await renderDataset();
    fireEvent.click(screen.getByRole('button', { name: '写入用例' }));
    fireEvent.change(screen.getByLabelText('输入（必填，≤20000 字）'), { target: { value: '问题三' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '写入' }));
      await Promise.resolve();
    });
    expect(screen.getByText(/存在无法原样回写的用例/)).toBeInTheDocument();
    expect(writeCall(fetchMock, 'PUT')).toBeUndefined();
  });

  it('403：弹窗内权限徽标，用例列表不动', async () => {
    datasetState = { id: 'ds-1', name: '问题集', description: null, version: 2, cases: CASE_ROWS };
    mockDatasetApi({ put: jsonResponse({ error: { code: 'FORBIDDEN', message: '权限不足' } }, 403) });
    await renderDataset();
    fireEvent.click(screen.getByRole('button', { name: '写入用例' }));
    fireEvent.change(screen.getByLabelText('输入（必填，≤20000 字）'), { target: { value: '问题三' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '写入' }));
      await Promise.resolve();
    });
    expect(await screen.findByTestId('forbidden-badge')).toHaveTextContent('403 权限不足 · 需要组织 owner/admin 权限（evaluation.write）');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByText('问题一')).toBeInTheDocument(); // 失败不改本地事实
  });
});
