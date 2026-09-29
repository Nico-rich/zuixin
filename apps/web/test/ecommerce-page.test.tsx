import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import EcommercePage from '@/app/ecommerce/page';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * /ecommerce 只读展示（M13-W9）：
 *  - 页面必须如实标注"工具即接口"（写路径由 Agent 工具执行）且**没有任何写操作入口**；
 *  - 分析详情按 `layering` 分块：facts/derived/anomalies = 服务端计算，
 *    possibleCauses/recommendations = LLM 推测——两条断言分别钉住，防止推测被渲染成事实；
 *  - 简报详情：problem/objective（人给）+ 创意方向（LLM 建议）+ evidence（事实快照）。
 */

const ANALYSIS = {
  analysisId: 'an-1', analysisType: 'sales', status: 'ready',
  timeRange: { days: 30 }, agentRunId: null, createdAt: '2026-09-29T00:00:00.000Z',
};
const ANALYSIS_DETAIL = {
  ...ANALYSIS,
  facts: { revenue: 800 },
  derived: { roas: 2 },
  anomalies: [{ metric: 'revenue', direction: 'decline', rule: 'server-threshold' }],
  possibleCauses: { source: 'llm-interpretation', items: ['流量质量下降（推测）'] },
  recommendations: { source: 'llm-recommendation', items: ['优化主图'] },
  layering: {
    facts: 'service-computed', derived: 'service-computed', anomalies: 'service-rule',
    possibleCauses: 'llm-interpretation', recommendations: 'llm-recommendation',
  },
};

const BRIEF = {
  briefId: 'cb-1', problem: '转化率下降', objective: '提升点击率', platform: 'meta',
  status: 'ready', artifactId: 'art-1', analysisId: 'an-1', createdAt: '2026-09-29T00:00:00.000Z',
};
const BRIEF_DETAIL = {
  id: 'cb-1', problem: '转化率下降', target: '一线城市女性', objective: '提升点击率',
  creativeAngle: '黑金质感', visualDirection: '黑金配色', copyDirection: '短句钩子',
  constraints: null, platform: 'meta', product: null,
  evidence: { source: 'commerce-analysis-snapshot', facts: { revenue: 800 } },
  status: 'ready', artifactId: 'art-1', commerceAnalysisId: 'an-1',
  createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
};

function mockApi(analyses: unknown[] = [ANALYSIS], briefs: unknown[] = [BRIEF]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/api\/v1\/commerce\/analyses\/[^?/]+$/.test(url)) return jsonResponse({ data: ANALYSIS_DETAIL });
    if (/\/api\/v1\/commerce\/briefs\/[^?/]+$/.test(url)) return jsonResponse({ data: BRIEF_DETAIL });
    if (url.includes('/api/v1/commerce/analyses')) return jsonResponse({ data: analyses });
    if (url.includes('/api/v1/commerce/briefs')) return jsonResponse({ data: briefs });
    throw new Error(`未预期的请求：${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('/ecommerce 电商只读展示（M13-W9）', () => {
  it('标注"工具即接口"，列表渲染，且页面没有任何写操作入口', async () => {
    mockApi();
    renderWithQuery(<EcommercePage />);

    expect(await screen.findByText(/工具即接口/)).toBeInTheDocument();
    expect(screen.getByText(/都由 Agent 工具执行/)).toBeInTheDocument();
    expect(screen.getByText(/不提供任何写操作/)).toBeInTheDocument();
    expect(await screen.findByText('sales')).toBeInTheDocument();

    const writeButton = /新建|创建|编辑|删除|上传|提交|生成/;
    const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    expect(buttons.filter((name) => writeButton.test(name))).toEqual([]);
  });

  it('分析详情：事实层与推测层分别标注（推测绝不冒充事实）', async () => {
    mockApi();
    renderWithQuery(<EcommercePage />);

    fireEvent.click(await screen.findByRole('button', { name: '查看分层详情' }));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText('事实（facts）')).toBeInTheDocument();
    expect(within(dialog).getAllByText('服务端计算').length).toBeGreaterThanOrEqual(2);
    expect(within(dialog).getByText('规则异常（anomalies）')).toBeInTheDocument();
    expect(within(dialog).getByText(/不是 LLM 判断/)).toBeInTheDocument();

    // 推测层：块标题 + "LLM 推测" 标注同时出现（source 不被隐藏）
    expect(within(dialog).getByText('可能原因（possibleCauses）')).toBeInTheDocument();
    expect(within(dialog).getByText('建议（recommendations）')).toBeInTheDocument();
    expect(within(dialog).getAllByText('LLM 推测').length).toBe(2);
    expect(within(dialog).getByText(/"source": "llm-interpretation"/)).toBeInTheDocument();
  });

  it('简报 tab：列表 + 详情（人给字段 / LLM 建议 / 事实证据快照分层呈现）', async () => {
    mockApi();
    renderWithQuery(<EcommercePage />);
    await screen.findByText('sales');

    fireEvent.click(screen.getByRole('tab', { name: '创意简报' }));
    expect(await screen.findByText('转化率下降')).toBeInTheDocument();
    expect(screen.getByText('目标：提升点击率')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '查看简报详情' }));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText('一线城市女性')).toBeInTheDocument();
    expect(within(dialog).getByText('创意角度（creativeAngle）')).toBeInTheDocument();
    expect(within(dialog).getByText('数据证据（evidence）')).toBeInTheDocument();
    expect(within(dialog).getByText(/分析事实快照/)).toBeInTheDocument();
  });

  it('空列表 → 两个 tab 各有明确空态（并提示可由哪个 Agent 工具生成）', async () => {
    mockApi([], []);
    renderWithQuery(<EcommercePage />);

    expect(await screen.findByText(/commerce\.analysis\.generate/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '创意简报' }));
    expect(await screen.findByText(/commerce\.brief\.create/)).toBeInTheDocument();
  });
});
