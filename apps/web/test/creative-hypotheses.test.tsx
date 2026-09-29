import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HypothesesPage from '@/app/creative/hypotheses/page';
import HypothesisDetailPage from '@/app/creative/hypotheses/[id]/page';
import {
  canAttachHypothesis, canConcludeHypothesis, canDeleteHypothesis, canEditHypothesis, canRejectHypothesis,
  canStartHypothesis, canSubmitHypothesis, concludeBlockedByRun, concludeDecisionOptions, criteriaText,
  isRunTerminal, isTerminalStatus, pollIntervalFor, POLL_INTERVAL_MS, windowLabel,
} from '@/app/creative/components/creative-view';
import type { HypothesisStatus } from '@/lib/services/creative';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * M13-W4 假设面（列表 / 详情）+ 纯规则
 *
 * 断言口径（M13 红线）：
 *  - 状态机裁决在服务端：前端只按镜像规则**禁用 + 常显原因**，绝不代替服务端放行；
 *  - 判定可达性如实镜像状态机（draft/ready 无 → validated 边，故判定方式只列可达项）；
 *  - 待办 / 回滚**原样呈现**（rollback=pending/failed 绝不被吞掉）；LLM 不决定治理判定；
 *  - 轮询：仅 running 态每 3 秒，终态停止。
 */

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/creative/hypotheses',
}));

const NOW = '2026-09-29T00:00:00.000Z';

function hypothesis(status: HypothesisStatus, extra: Record<string, unknown> = {}) {
  return {
    id: 'hyp-1',
    kind: 'creative_hypothesis',
    organizationId: 'org-1',
    projectId: null,
    status,
    statement: '高对比主视觉可提升 CTR',
    rationale: '同类素材对比度更高时点击率更好',
    target: '25-34 女性',
    platform: null,
    insightId: null,
    successCriteria: null,
    loop: null,
    evaluationRunId: null,
    baselineRunId: null,
    experimentId: null,
    verdict: null,
    history: [],
    terminal: status === 'validated' || status === 'rejected',
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

const READY = hypothesis('ready', { platform: 'meta_ads', successCriteria: { metric: 'ctr', op: 'gte', value: 0.05 } });
const RUNNING = hypothesis('running', {
  insightId: 'ins-1',
  successCriteria: { metric: 'ctr', op: 'gte', value: 0.05 },
  loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 1, startedAt: NOW },
});
const VALIDATED = hypothesis('validated', {
  insightId: 'ins-1',
  successCriteria: { metric: 'ctr', op: 'gte', value: 0.05 },
  loop: { workflowId: 'wf-1', runId: 'run-1', attempts: 2, startedAt: NOW },
  evaluationRunId: 'eval-1',
  baselineRunId: 'base-1',
  experimentId: 'exp-1',
  verdict: {
    decision: 'validated', decidedBy: 'criteria', reason: 'CTR 达 0.06 ≥ 0.05',
    criteria: { metric: 'ctr', op: 'gte', value: 0.05 }, facts: { ctr: 0.06 }, decidedAt: NOW,
  },
  history: [
    { from: 'draft', to: 'ready', at: NOW, by: 'manual' },
    { from: 'ready', to: 'running', at: NOW, by: 'manual' },
    { from: 'running', to: 'validated', at: NOW, by: 'criteria' },
  ],
});

const RUN_DETAIL = {
  runId: 'run-1', workflowId: 'wf-1', version: 3, status: 'running', attempt: 1, currentStep: 2,
  waitingOnApprovalId: 'approval-1', startedAt: NOW, completedAt: null, errorCode: null,
  steps: [
    { stepId: 'step-1', stepIndex: 1, stepType: 'tool', status: 'completed', attempt: 1, completedAt: NOW },
    { stepId: 'step-2', stepIndex: 2, stepType: 'approval', status: 'running', attempt: 1, approvalId: 'approval-1', completedAt: null },
  ],
};

const EVAL_RUN = { id: 'eval-run-1', status: 'completed', datasetVersion: 3, completedAt: NOW };

/** 各状态的完整视图夹具（详情页以 status 端点为唯一状态源） */
function fixtureFor(status: HypothesisStatus) {
  if (status === 'ready') return READY;
  if (status === 'running') return RUNNING;
  if (status === 'validated') return VALIDATED;
  return hypothesis('draft');
}

/** 列表页：GET 列表 + POST 创建 */
function mockList(hypotheses: unknown[] = [hypothesis('draft')]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.endsWith('/creative-loop/hypotheses')) return jsonResponse({ data: hypothesis('draft', { id: 'hyp-new' }) }, 201);
    if (url.includes('/creative-loop/hypotheses')) return jsonResponse({ data: { hypotheses } });
    throw new Error(`未预期的请求：${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 详情页：按当前状态动态应答（便于轮询用例改状态） */
function mockDetail(getStatus: () => HypothesisStatus, getRunStatus: () => string | null = () => 'running') {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return jsonResponse({ data: fixtureFor(getStatus()) });
    if (url.includes('/evaluation/runs')) return jsonResponse({ data: { runs: [EVAL_RUN] } });
    if (url.includes('/evaluation/experiments')) {
      return jsonResponse({ data: { experiments: [{ id: 'exp-1', name: '主视觉 A/B', status: 'completed', variantCount: 2 }] } });
    }
    const status = getStatus();
    const runStatus = getRunStatus();
    const base = fixtureFor(status);
    if (url.endsWith('/status')) {
      return jsonResponse({
        data: {
          hypothesis: base,
          run: runStatus ? { id: 'run-1', status: runStatus, startedAt: NOW, completedAt: null } : null,
          insightId: null, insightFactsHash: null,
          pending: status === 'running'
            ? { reason: 'observing', detail: '等待绩效观察窗（默认 1 小时）' }
            : { reason: null, detail: status === 'validated' ? '判定已落地（终态）' : '尚未启动 loop（无待办）' },
          rollback: status === 'running'
            ? { required: true, status: 'pending', publishActionId: 'act-1', detail: '已发布但未见补偿链留痕' }
            : status === 'validated'
              ? { required: true, status: 'completed', compensateStepId: 'step-comp-1', detail: null }
              : { required: false, status: 'not-required', detail: null },
        },
      });
    }
    if (url.endsWith('/run')) {
      return jsonResponse({
        data: {
          hypothesis: base, run: RUN_DETAIL,
          pending: { reason: 'observing', detail: '等待绩效观察窗' },
          rollback: { required: true, status: 'pending', publishActionId: 'act-1' },
        },
      });
    }
    if (url.endsWith('/hypotheses/hyp-1')) return jsonResponse({ data: base });
    throw new Error(`未预期的请求：${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const writeCalls = (fetchMock: ReturnType<typeof vi.fn>, suffix: string) =>
  fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && (init as RequestInit | undefined)?.method);
const bodyOf = (call: unknown[] | undefined) => JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? '{}'));
const hrefs = () => Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));

beforeEach(() => { pushMock.mockClear(); });

describe('创意假设列表（/creative/hypotheses）', () => {
  it('列表渲染：陈述 / 状态 Badge + 原值 / 判据摘要 / 状态机图例', async () => {
    mockList([hypothesis('draft', { id: 'hyp-a' }), { ...READY, id: 'hyp-b' }, { ...VALIDATED, id: 'hyp-c' }]);
    renderWithQuery(<HypothesesPage />);

    await screen.findByRole('heading', { name: '创意假设' });
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText(/未声明判据/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/判据 ctr ≥ 0.05/)).toBeInTheDocument();
    expect(within(rows[1]).getByText('就绪')).toBeInTheDocument();
    expect(within(rows[1]).getByText('ready')).toBeInTheDocument();
    expect(within(rows[2]).getByText('已验证')).toBeInTheDocument();
    expect(within(rows[2]).getByText(/判定者 criteria/)).toBeInTheDocument();
    // 状态机图例（无当前态 → 只画常量图）
    const machine = screen.getByTestId('status-machine');
    expect(within(machine).getByText('草稿')).toBeInTheDocument();
    expect(within(machine).getByText('已驳回')).toBeInTheDocument();
    expect(rows[0].querySelector('a')).toHaveAttribute('href', '/creative/hypotheses/hyp-a');
  });

  it('空列表给出可执行下一步，而不是空白', async () => {
    mockList([]);
    renderWithQuery(<HypothesesPage />);
    expect(await screen.findByText(/暂无假设/)).toBeInTheDocument();
  });

  it('状态筛选走服务端 status 参数（不是客户端过滤）', async () => {
    const fetchMock = mockList([RUNNING]);
    renderWithQuery(<HypothesesPage />);
    await screen.findByRole('heading', { name: '创意假设' });

    fireEvent.change(screen.getByLabelText('状态筛选'), { target: { value: 'running' } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('status=running'))).toBe(true));
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('status=draft'))).toBe(true);
  });

  it('新建假设：Dialog 提交 statement + 判据，请求体只含已填字段（strictObject）', async () => {
    const fetchMock = mockList([]);
    renderWithQuery(<HypothesesPage />);
    await screen.findByRole('heading', { name: '创意假设' });

    fireEvent.click(screen.getByRole('button', { name: '新建假设' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('假设陈述'), { target: { value: '换高对比主视觉后 CTR 提升' } });
    fireEvent.change(within(dialog).getByLabelText('target'), { target: { value: '25-34 女性' } });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.change(within(dialog).getByLabelText('判据阈值'), { target: { value: '0.85' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建假设' }));

    await waitFor(() => expect(writeCalls(fetchMock, '/creative-loop/hypotheses')).toHaveLength(1));
    expect(bodyOf(writeCalls(fetchMock, '/creative-loop/hypotheses')[0])).toEqual({
      statement: '换高对比主视觉后 CTR 提升',
      target: '25-34 女性',
      successCriteria: { metric: 'avg_score', op: 'gte', value: 0.85 },
    });
  });

  it('新建假设：陈述过短在前端拦下（不发请求，错误常显）', async () => {
    const fetchMock = mockList([]);
    renderWithQuery(<HypothesesPage />);
    await screen.findByRole('heading', { name: '创意假设' });

    fireEvent.click(screen.getByRole('button', { name: '新建假设' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('假设陈述'), { target: { value: 'ok' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建假设' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('假设陈述需 4~300 字');
    expect(writeCalls(fetchMock, '/creative-loop/hypotheses')).toHaveLength(0);
  });

  it('?insightId= 入口预填来源洞察并直接打开 Dialog', async () => {
    window.history.pushState({}, '', '/creative/hypotheses?insightId=ins-9');
    try {
      mockList([]);
      renderWithQuery(<HypothesesPage />);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByLabelText('来源洞察 ID')).toHaveValue('ins-9');
    } finally {
      window.history.pushState({}, '', '/creative/hypotheses');
    }
  });
});

describe('假设详情（/creative/hypotheses/[id]）', () => {
  async function renderDetail(getStatus: () => HypothesisStatus, getRunStatus?: () => string | null) {
    const fetchMock = mockDetail(getStatus, getRunStatus);
    await act(async () => {
      renderWithQuery(<HypothesisDetailPage params={Promise.resolve({ id: 'hyp-1' })} />);
    });
    await screen.findByRole('heading', { level: 1 });
    return fetchMock;
  }

  it('draft：状态机高亮当前态；缺失的启用条件被禁用且原因常显', async () => {
    await renderDetail(() => 'draft');

    const machine = screen.getByTestId('status-machine');
    expect(machine.querySelector('[aria-current="step"]')).toHaveTextContent('草稿');
    expect(within(machine).getByText('可达：就绪、已驳回')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: '编辑假设' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '提交就绪' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '删除假设' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '启动 loop' })).toBeDisabled();
    expect(screen.getByText('仅就绪（ready）可启动（当前 draft）；外部副作用走审批 + 补偿链')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '挂接评测' })).toBeDisabled();
    expect(screen.getByText('仅就绪/执行中可挂接（当前 draft）——评测与流量选路严格分离')).toBeInTheDocument();
    // 未启动 loop：无 loop 引用、无待办、回滚 not-required、历史链空态
    expect(screen.getByText('未启动（无 loop 引用）')).toBeInTheDocument();
    expect(screen.getByText('尚未启动 loop（无待办）')).toBeInTheDocument();
    expect(screen.getByText('无需回滚（平台写操作未执行）')).toBeInTheDocument();
    expect(screen.getByText('尚无状态推进记录（仍为初始 draft）')).toBeInTheDocument();
    expect(screen.getByText('无来源洞察')).toBeInTheDocument();
    expect(screen.getByText('尚未启动 loop（启动后此处显示 run 状态与步骤留痕）')).toBeInTheDocument();
    // 轮询提示：头部与运行明细各一处，均声明未轮询
    const hints = screen.getAllByTestId('polling-hint');
    expect(hints.length).toBe(2);
    hints.forEach((hint) => expect(hint).toHaveTextContent('未轮询（仅执行中态轮询，终态停止）'));
  });

  it('draft 判定：只列出可达的判定方式（状态机无 draft → validated 边）', async () => {
    await renderDetail(() => 'draft');

    fireEvent.click(screen.getByRole('button', { name: '判定' }));
    const dialog = await screen.findByRole('dialog');
    const select = within(dialog).getByLabelText('判定方式');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(options).toEqual(['rejected']);
    expect(within(dialog).getByText(/状态机无 draft → validated 边/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '确认判定' })).toBeEnabled();
  });

  it('ready → 启动 loop：观察窗越界前端拦下；合法值随请求体下发（含假设默认 platform）', async () => {
    const fetchMock = await renderDetail(() => 'ready', () => null);

    fireEvent.click(screen.getByRole('button', { name: '启动 loop' }));
    const dialog = await screen.findByRole('dialog');
    // 预填假设默认 platform
    expect(within(dialog).getByLabelText('platform')).toHaveValue('meta_ads');
    fireEvent.change(within(dialog).getByLabelText('观察窗'), { target: { value: '100' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认启动' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('观察窗必须是 500~604800000 之间的整数毫秒');
    expect(writeCalls(fetchMock, '/start')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText('风险级别'), { target: { value: 'medium' } });
    fireEvent.change(within(dialog).getByLabelText('观察窗'), { target: { value: '3600000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认启动' }));
    await waitFor(() => expect(writeCalls(fetchMock, '/start')).toHaveLength(1));
    expect(bodyOf(writeCalls(fetchMock, '/start')[0])).toEqual({
      platform: 'meta_ads', target: '25-34 女性', riskLevel: 'medium', waitMs: 3600000,
    });
  });

  it('running：轮询提示生效、判定被未终态 run 挡住、待办与回滚原样可见', async () => {
    await renderDetail(() => 'running', () => 'running');

    const hints = screen.getAllByTestId('polling-hint');
    expect(hints.length).toBeGreaterThan(0);
    hints.forEach((hint) => expect(hint).toHaveTextContent('执行中：每 3 秒自动刷新，终态停止'));

    const conclude = screen.getByRole('button', { name: '判定' });
    expect(conclude).toBeDisabled();
    expect(screen.getByText('loop 仍在执行（run=running），待运行结束后判定')).toBeInTheDocument();

    // 执行中：假设陈述已固化 → 不可编辑/删除；但可挂接评测与实验
    expect(screen.getByRole('button', { name: '编辑假设' })).toBeDisabled();
    expect(screen.getByText('仅草稿/就绪可编辑——loop 启动后假设陈述已固化进定义与审批理由')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除假设' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '挂接评测' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '挂接实验' })).toBeEnabled();

    // 待办与回滚：pending 绝不吞掉
    expect(screen.getByText('绩效观察窗')).toBeInTheDocument();
    expect(screen.getByText('observing')).toBeInTheDocument();
    expect(screen.getByText('待回滚（已发布但未见补偿链留痕）')).toBeInTheDocument();
    expect(screen.getByText('已发布但未见补偿链留痕')).toBeInTheDocument();
    expect(screen.getByText('act-1')).toBeInTheDocument();

    // 运行明细：步骤留痕 + 完整 timeline 入口（run 明细需待 doc 解析后才启用）
    expect(await screen.findByText('step-2')).toBeInTheDocument();
    expect(screen.getByText('待审批 approval-1')).toBeInTheDocument();
    expect(hrefs()).toContain('/workflows/runs/run-1');
    expect(hrefs()).toContain('/creative/insights/ins-1');
  });

  it('validated 终态：verdict / 引用 / 历史链如实呈现，变更操作全部禁用并给出终态原因', async () => {
    await renderDetail(() => 'validated', () => 'completed');

    expect(screen.getByText('成立（validated）')).toBeInTheDocument();
    expect(screen.getByText('服务端按判据判定')).toBeInTheDocument();
    expect(screen.getByText('CTR 达 0.06 ≥ 0.05')).toBeInTheDocument();
    expect(screen.getByText('终态只读（重跑走新假设行）')).toBeInTheDocument();
    expect(screen.getByText('已回滚（补偿链已完成）')).toBeInTheDocument();
    expect(hrefs()).toContain('/workflows/runs/run-1');
    expect(hrefs()).toContain('/workflows/wf-1');
    expect(hrefs()).toContain('/evaluation/runs/eval-1');
    expect(hrefs()).toContain('/evaluation/runs/base-1');
    expect(screen.getByText('exp-1')).toBeInTheDocument();
    // 历史状态链：每次 CAS 推进
    expect(screen.getByText('draft → ready')).toBeInTheDocument();
    expect(screen.getByText('running → validated')).toBeInTheDocument();
    expect(screen.getAllByText('criteria').length).toBeGreaterThanOrEqual(2); // 判定者 + 历史链
    expect(screen.getAllByText('manual').length).toBeGreaterThanOrEqual(2); // 历史链两次人工推进
    // 终态：不再有任何变更入口
    expect(screen.getByRole('button', { name: '编辑假设' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '启动 loop' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '判定' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '挂接评测' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除假设' })).toBeDisabled();
    expect(screen.getAllByText('假设已终态（validated），不可再变更').length).toBeGreaterThan(0);
    expect(screen.getByText('终态只读（validated）')).toBeInTheDocument();
  });

  it('挂接评测：从组织评测运行中选择后提交 POST /evaluation', async () => {
    const fetchMock = await renderDetail(() => 'ready', () => null);

    fireEvent.click(screen.getByRole('button', { name: '挂接评测' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByLabelText('评测运行').querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(within(dialog).getByLabelText('评测运行'), { target: { value: 'eval-run-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认挂接' }));

    await waitFor(() => expect(writeCalls(fetchMock, '/evaluation')).toHaveLength(1));
    expect(bodyOf(writeCalls(fetchMock, '/evaluation')[0])).toEqual({ evaluationRunId: 'eval-run-1' });
  });

  it('draft 删除：DELETE 后回到列表', async () => {
    const fetchMock = await renderDetail(() => 'draft');

    fireEvent.click(screen.getByRole('button', { name: '删除假设' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/hypotheses/hyp-1') && (init as RequestInit)?.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/creative/hypotheses'));
  });

  it('执行中态每 3 秒轮询 status/run，收敛为终态后停止', async () => {
    vi.useFakeTimers();
    try {
      let phase: HypothesisStatus = 'running';
      const fetchMock = mockDetail(() => phase);
      const countOf = (suffix: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix)).length;

      await act(async () => {
        renderWithQuery(<HypothesisDetailPage params={Promise.resolve({ id: 'hyp-1' })} />);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(countOf('/status')).toBe(1);
      expect(countOf('/run')).toBe(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 200); });
      expect(countOf('/status')).toBe(2);
      expect(countOf('/run')).toBe(2);

      phase = 'validated';
      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 200); });
      const settled = countOf('/status');
      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5); });
      expect(countOf('/status')).toBe(settled);
      expect(countOf('/run')).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('纯规则：状态机镜像 / 判定可达性 / 轮询（服务端仍是裁决方）', () => {
  it('轮询策略：仅 running 态轮询（3s），其余一律 false', () => {
    expect(POLL_INTERVAL_MS).toBe(3000);
    expect(pollIntervalFor('running')).toBe(3000);
    (['draft', 'ready', 'validated', 'rejected', null, undefined] as const)
      .forEach((status) => expect(pollIntervalFor(status)).toBe(false));
  });

  it('操作可达性镜像后端（EDITABLE=draft|ready；remove=draft|rejected；start=ready；attach=ready|running）', () => {
    const ALL: readonly HypothesisStatus[] = ['draft', 'ready', 'running', 'validated', 'rejected'];
    expect(ALL.filter(canEditHypothesis)).toEqual(['draft', 'ready']);
    expect(ALL.filter(canDeleteHypothesis)).toEqual(['draft', 'rejected']);
    expect(ALL.filter(canSubmitHypothesis)).toEqual(['draft']);
    expect(ALL.filter(canRejectHypothesis)).toEqual(['draft', 'ready']);
    expect(ALL.filter(canStartHypothesis)).toEqual(['ready']);
    expect(ALL.filter(canAttachHypothesis)).toEqual(['ready', 'running']);
    expect(ALL.filter(canConcludeHypothesis)).toEqual(['draft', 'ready', 'running']);
    expect(ALL.filter(isTerminalStatus)).toEqual(['validated', 'rejected']);
  });

  it('判定方式只列可达项：criteria 需 running + 判据；validated 仅 running 可达', () => {
    expect(concludeDecisionOptions('draft', false)).toEqual(['rejected']);
    expect(concludeDecisionOptions('draft', true)).toEqual(['rejected']);
    expect(concludeDecisionOptions('ready', true)).toEqual(['rejected']);
    expect(concludeDecisionOptions('running', false)).toEqual(['validated', 'rejected']);
    expect(concludeDecisionOptions('running', true)).toEqual(['criteria', 'validated', 'rejected']);
    expect(concludeDecisionOptions('validated', true)).toEqual([]);
    expect(concludeDecisionOptions('rejected', true)).toEqual([]);
    // 终态无判定入口（canConclude 也拦一道）
    expect(canConcludeHypothesis('validated')).toBe(false);
  });

  it('判定被未终态 run 挡住（running + run 未终态 → 服务端 400，前端前置禁用）', () => {
    expect(isRunTerminal('completed')).toBe(true);
    expect(isRunTerminal('failed')).toBe(true);
    expect(isRunTerminal('cancelled')).toBe(true);
    expect(isRunTerminal('timeout')).toBe(true);
    expect(isRunTerminal('running')).toBe(false);
    expect(isRunTerminal(null)).toBe(false);
    expect(concludeBlockedByRun('running', 'running')).toBe(true);
    expect(concludeBlockedByRun('running', 'waiting')).toBe(true);
    expect(concludeBlockedByRun('running', 'completed')).toBe(false);
    expect(concludeBlockedByRun('running', null)).toBe(false);
    expect(concludeBlockedByRun('draft', 'running')).toBe(false);
  });

  it('判据/窗口文本：缺失一律返回占位（绝不臆造判据）', () => {
    expect(criteriaText({ metric: 'ctr', op: 'gte', value: 0.05 })).toBe('ctr ≥ 0.05');
    expect(criteriaText({ metric: 'avg_score', op: 'lte', value: 0.5 })).toBe('avg_score ≤ 0.5');
    expect(criteriaText(null)).toBeNull();
    expect(windowLabel({ start: NOW, end: NOW, days: 30 })).toContain('30 天');
    expect(windowLabel(null)).toBe('窗口未知');
  });
});
