import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CreativeWorkspacePage from '@/app/creative/page';
import InsightDetailPage from '@/app/creative/insights/[id]/page';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * M13-W4 Creative 工作台：洞察面（总览 / 详情）
 *
 * 断言口径：
 *  - **分层如实呈现**：facts（事实）/ derived（派生）/ interpretation（LLM 解读）三层各有独立分区与标注，
 *    解读未写入时明说"无解读"（绝不用空对象冒充已解读）；
 *  - 事实/派生只做展示（页面不重算任何指标）；
 *  - 解读写入走独立端点，请求体只含 items/model（strictObject 不接受多余字段）；
 *  - 引用该洞察的假设为**客户端过滤**（后端列表端点无 insightId 参数）——过滤口径在页面上明示。
 */

const WINDOW = { start: '2026-08-30T00:00:00.000Z', end: '2026-09-29T00:00:00.000Z', days: 30 };

const FACTS = {
  window: WINDOW,
  performance: {
    current: { impressions: 1200, clicks: 36, spend: 12.3, conversions: 4, revenue: 40, orders: 3 },
    previous: { impressions: 1000, clicks: 20, spend: 10, conversions: 3, revenue: 30, orders: 2 },
    sources: { current: 2, previous: 1 },
    rule: 'server-sum',
  },
  ratings: { count: 5, avgRating: 4.2, distribution: { '1': 0, '2': 0, '3': 1, '4': 2, '5': 2 }, positiveRate: 0.8, negativeRate: 0, rule: 'server-sum' },
  evaluation: { runs: [], rule: 'evaluation-run-summary' },
};

const DERIVED = {
  metrics: { ctr: 0.03, cvr: 0.11, roas: 3.25, cpc: 0.34 },
  baseline: { ctr: 0.02, cvr: 0.1, roas: 3, cpc: 0.35 },
  comparison: [{ metric: 'ctr', base: 0.02, compare: 0.03, changePct: 50, direction: 'up', beyondThreshold: true, rule: 'server-comparison' }],
  ratingSummary: { avgRating: 4.2, positiveRate: 0.8, negativeRate: 0 },
  evaluation: null,
  rule: 'server-comparison',
};

function insight(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ins-1',
    kind: 'creative_insight',
    organizationId: 'org-1',
    projectId: null,
    window: WINDOW,
    filters: { artifactId: null, campaignId: null, projectId: null },
    facts: FACTS,
    derived: DERIVED,
    factsHash: 'f'.repeat(64),
    interpretation: null,
    layering: { facts: 'service-computed', derived: 'service-computed', interpretation: 'llm-interpretation' },
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

const INTERPRETATION = {
  source: 'llm-interpretation',
  items: ['CTR 环比上升主要来自素材 A 的主视觉更换', 'ROAS 仍低于目标，需先控预算'],
  model: 'gpt-4o-mini',
  attachedAt: '2026-09-29T02:00:00.000Z',
};

const INTERPRETED = insight({ interpretation: INTERPRETATION });

function mockOverview(insights: unknown[] = [insight()]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/creative-loop/insights')) return jsonResponse({ data: insight({ id: 'ins-new' }) }, 201);
    if (url.includes('/creative-loop/insights')) return jsonResponse({ data: { insights } });
    throw new Error(`未预期的请求：${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mockDetail(detail: unknown = insight(), hypotheses: unknown[] = []) {
  /** 解读写入后就当作已落库（模拟服务端 factsHash 条件更新成功） */
  let written = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/interpretation')) {
      written = true;
      return jsonResponse({ data: INTERPRETED });
    }
    if (url.includes('/creative-loop/hypotheses')) return jsonResponse({ data: { hypotheses } });
    if (url.includes('/creative-loop/insights/')) return jsonResponse({ data: written ? INTERPRETED : detail });
    throw new Error(`未预期的请求：${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const writeCalls = (fetchMock: ReturnType<typeof vi.fn>, suffix: string) =>
  fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && (init as RequestInit | undefined)?.method === 'POST');

describe('创意工作台总览（/creative）', () => {
  it('洞察列表：窗口 + 事实摘要 + 分层标注（解读未写入时标"无解读"）', async () => {
    mockOverview([insight(), insight({ id: 'ins-2', interpretation: INTERPRETATION })]);
    renderWithQuery(<CreativeWorkspacePage />);

    await screen.findByRole('heading', { name: '创意工作台' });
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);

    const first = rows[0];
    expect(within(first).getByText(/30 天/)).toBeInTheDocument();
    // 事实摘要只拼 facts 中真实存在的字段
    expect(within(first).getByText(/曝光 1200/)).toBeInTheDocument();
    expect(within(first).getByText(/评分条数 5/)).toBeInTheDocument();
    // 分层标注：事实 / 派生 恒在；解读未写入 → 明确"无解读"
    expect(within(first).getByText('事实')).toBeInTheDocument();
    expect(within(first).getByText('派生')).toBeInTheDocument();
    expect(within(first).getByText('无解读')).toBeInTheDocument();
    // 已写入解读的洞察标注 LLM 解读层
    expect(within(rows[1]).getByText('LLM 解读')).toBeInTheDocument();
    expect(within(rows[1]).getByRole('link')).toHaveAttribute('href', '/creative/insights/ins-2');
  });

  it('构建新洞察：Dialog 提交 buildInsight（时间窗口 + 筛选），请求体只含契约字段', async () => {
    const fetchMock = mockOverview([]);
    renderWithQuery(<CreativeWorkspacePage />);
    await screen.findByRole('heading', { name: '创意工作台' });
    expect(await screen.findByText(/暂无洞察/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '构建新洞察' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('时间窗口（天）'), { target: { value: '7' } });
    fireEvent.change(within(dialog).getByLabelText('创意 ID'), { target: { value: '1f2e3d4c-5b6a-4798-8c9d-0e1f2a3b4c5d' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '构建洞察' }));

    await waitFor(() => expect(writeCalls(fetchMock, '/creative-loop/insights')).toHaveLength(1));
    const [, init] = writeCalls(fetchMock, '/creative-loop/insights')[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      days: 7,
      includeEvaluation: true,
      artifactId: '1f2e3d4c-5b6a-4798-9c1c-0e1f2a3b4c5d'.replace('9c1c', '8c9d'),
    });
  });

  it('构建新洞察：非法窗口/非 UUID 筛选在前端拦下（不发请求）', async () => {
    const fetchMock = mockOverview([]);
    renderWithQuery(<CreativeWorkspacePage />);
    await screen.findByRole('heading', { name: '创意工作台' });

    fireEvent.click(screen.getByRole('button', { name: '构建新洞察' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('时间窗口（天）'), { target: { value: '0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '构建洞察' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('时间窗口必须是 1~365 之间的整数天');

    fireEvent.change(within(dialog).getByLabelText('时间窗口（天）'), { target: { value: '30' } });
    fireEvent.change(within(dialog).getByLabelText('广告 ID'), { target: { value: 'not-a-uuid' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '构建洞察' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('广告 ID（campaignId）必须是 UUID');
    expect(writeCalls(fetchMock, '/creative-loop/insights')).toHaveLength(0);
  });
});

describe('洞察详情（/creative/insights/[id]）', () => {
  async function renderDetail(detail: unknown = insight(), hypotheses: unknown[] = []) {
    const fetchMock = mockDetail(detail, hypotheses);
    await act(async () => {
      renderWithQuery(<InsightDetailPage params={Promise.resolve({ id: 'ins-1' })} />);
    });
    await screen.findByRole('heading', { name: '洞察快照' });
    return fetchMock;
  }

  it('三层分区各带来源标注，并展示 factsHash 事实层指纹', async () => {
    await renderDetail();

    const factsSection = document.querySelector('section[data-layer="facts"]') as HTMLElement;
    const derivedSection = document.querySelector('section[data-layer="derived"]') as HTMLElement;
    const interpretationSection = document.querySelector('section[data-layer="interpretation"]') as HTMLElement;
    expect(factsSection).toBeTruthy();
    expect(derivedSection).toBeTruthy();
    expect(interpretationSection).toBeTruthy();

    // 分层来源（layering 原值）如实标注
    expect(within(factsSection).getByText('service-computed')).toBeInTheDocument();
    expect(within(interpretationSection).getByText('llm-interpretation')).toBeInTheDocument();
    // 事实层展示聚合事实（标量投影 + 原始 JSON 双通道；页面不重算）
    expect(within(factsSection).getByText('绩效.impressions')).toBeInTheDocument();
    expect(within(factsSection).getAllByText('1200').length).toBeGreaterThan(0);
    // 派生层展示服务端派生指标与环比规则来源
    expect(within(derivedSection).getByText('当期.ctr')).toBeInTheDocument();
    expect(within(derivedSection).getAllByText('server-comparison').length).toBeGreaterThan(0);
    expect(within(derivedSection).getByText('越过阈值')).toBeInTheDocument();
    // 解读层留空 → 明说未写入（不冒充）
    expect(within(interpretationSection).getByText(/尚未写入解读/)).toBeInTheDocument();
    // factsHash 原样展示
    expect(screen.getByText('f'.repeat(64))).toBeInTheDocument();
  });

  it('写入解读：按行切分去空行；未填模型即 null（strictObject 契约字段），并提示 LLM 不决定治理判定', async () => {
    const fetchMock = await renderDetail(insight(), []);

    fireEvent.click(screen.getByRole('button', { name: '写入 LLM 解读' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/LLM 只做解读/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('解读要点'), { target: { value: '线索一\n\n线索二  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '写入解读' }));

    await waitFor(() => expect(writeCalls(fetchMock, '/interpretation')).toHaveLength(1));
    const [url, init] = writeCalls(fetchMock, '/interpretation')[0];
    expect(String(url)).toBe('/api/v1/creative-loop/insights/ins-1/interpretation');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ items: ['线索一', '线索二'], model: null });

    // 重写：模型标注原样透传（解读层独立写入，事实层不动）
    fireEvent.click(await screen.findByRole('button', { name: '重写 LLM 解读' }));
    const rewrite = await screen.findByRole('dialog');
    fireEvent.change(within(rewrite).getByLabelText('解读要点'), { target: { value: '复核要点' } });
    fireEvent.change(within(rewrite).getByLabelText('模型标注'), { target: { value: 'gpt-4o-mini' } });
    fireEvent.click(within(rewrite).getByRole('button', { name: '写入解读' }));

    await waitFor(() => expect(writeCalls(fetchMock, '/interpretation')).toHaveLength(2));
    expect(JSON.parse(String((writeCalls(fetchMock, '/interpretation')[1][1] as RequestInit).body)))
      .toEqual({ items: ['复核要点'], model: 'gpt-4o-mini' });
  });

  it('写入解读：空要点在前端拦下（不发请求）', async () => {
    const fetchMock = await renderDetail(insight(), []);

    fireEvent.click(screen.getByRole('button', { name: '写入 LLM 解读' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('解读要点'), { target: { value: '   \n  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '写入解读' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('至少输入一条解读要点');
    expect(writeCalls(fetchMock, '/interpretation')).toHaveLength(0);
  });

  it('已写入的解读：展示条目/模型，并可直接重写', async () => {
    await renderDetail(INTERPRETED);

    const interpretationSection = document.querySelector('section[data-layer="interpretation"]') as HTMLElement;
    expect(within(interpretationSection).getByText(/CTR 环比上升主要来自素材 A 的主视觉更换/)).toBeInTheDocument();
    expect(within(interpretationSection).getByText(/模型 gpt-4o-mini/)).toBeInTheDocument();
    expect(within(interpretationSection).getByRole('button', { name: '重写 LLM 解读' })).toBeInTheDocument();
  });

  it('引用该洞察的假设：客户端按 insightId 过滤（并明示该口径）', async () => {
    const referencing = {
      id: 'hyp-1', statement: '走主视觉换色提升 CTR', status: 'draft', insightId: 'ins-1',
      terminal: false, updatedAt: '2026-09-29T00:00:00.000Z',
    };
    const other = {
      id: 'hyp-2', statement: '与洞察无关的假设', status: 'ready', insightId: 'ins-other',
      terminal: false, updatedAt: '2026-09-29T00:00:00.000Z',
    };
    const fetchMock = await renderDetail(insight(), [referencing, other]);

    const section = (await screen.findByRole('heading', { name: '引用该洞察的假设' })).closest('section') as HTMLElement;
    await waitFor(() => expect(within(section).getByText('走主视觉换色提升 CTR')).toBeInTheDocument());
    expect(within(section).queryByText('与洞察无关的假设')).toBeNull();
    expect(within(section).getByText(/后端假设列表端点无 insightId 参数/)).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: /基于该洞察新建假设/ }))
      .toHaveAttribute('href', '/creative/hypotheses?insightId=ins-1');
    // 组织维度的列表请求（服务端 scope）
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('organizationId=org-1'))).toBe(true);
  });
});
