import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AnalyticsPage from '@/app/analytics/page';
import { ToastProvider } from '@/components/ui/toast';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * /analytics（M13-W6）——**分层绝不混排**是本页的主契约：
 *  ① facts（事实：事务表确定性投影）只出现在「事实」区，键值原样直出；
 *  ② derived（派生：服务端计算）只出现在「派生」区，且必须带「派生」Badge（派生值不是事实源）；
 *  ③ meta（口径：source/refreshedAt/rows/layering）只出现在「口径」区，含 layering 原文；
 *  ④ 手动刷新是 owner 专属写端点（billing.write）：角色如实显示、403 如实转述，且请求经 useApiMutation 发出。
 */

const REFRESHED_AT = new Date(2026, 8, 29, 9, 2).toISOString(); // 本地 2026-09-29 09:02（时区无关断言）
const ORG_ID = 'personal-u1';

const OVERVIEW = {
  organizationId: ORG_ID,
  range: 'day',
  from: '2026-09-29',
  to: '2026-09-29',
  days: 1,
  facts: {
    usage: { agent_run: 3, llm_tokens: 1234, entries: 5 },
    agent: { runs: 4, completed: 3, failed: 1, durationMsTotal: 9000, durationSamples: 3, avgDurationMs: 3000 },
    generation: { tasks: 2, imageSucceeded: 2, estimatedCost: 0.02 },
    provider: { calls: 12, estimatedCost: 0.5, llmCost: 0.4, mediaCost: 0.1, byProvider: { mock: { calls: 12, failed: 1 } } },
    workflow: { runs: 1, completed: 1 },
  },
  context: { members: 2 },
  derived: {
    totalCost: 0.5, llmCost: 0.4, providerCost: 0.45, runSuccessRate: 0.75, avgRunDurationMs: 9000,
    costPerRun: 0.125, costPerMember: 0.25, costPerDay: 0.42, runsPerDay: 4, imagesPerDay: 2, workflowSuccessRate: 1,
  },
  meta: {
    source: ['agent_run', 'usage_ledger'],
    refreshedAt: REFRESHED_AT,
    rows: 5,
    layering: { facts: 'deterministic-projection', derived: 'service-computed', interpretation: 'none' },
  },
};

const BREAKDOWN = {
  organizationId: ORG_ID,
  kind: 'usage',
  from: '2026-08-31',
  to: '2026-09-29',
  days: 30,
  series: [
    { kind: 'usage', period: '2026-09-28', metrics: { agent_run: 2, llm_tokens: 800 }, dimensions: null, source: 'usage_ledger' },
    { kind: 'usage', period: '2026-09-29', metrics: { agent_run: 1, llm_tokens: 434 }, dimensions: null, source: 'usage_ledger' },
  ],
  facts: { usage: { agent_run: 3, llm_tokens: 1234 } },
  meta: { source: ['usage_ledger'], refreshedAt: REFRESHED_AT, rows: 2, layering: { facts: 'deterministic-projection', derived: 'service-computed' } },
};

const SOURCES = {
  organizationId: ORG_ID,
  period: '2026-09-29',
  kindSourceMap: { usage: 'usage_ledger', agent: 'agent_run', generation: 'generation_task', provider: 'usage_record', workflow: 'workflow_run' },
  count: 2,
  sources: [
    { kind: 'usage', source: 'usage_ledger', period: '2026-09-29', scope: 'organization', metricKeys: ['agent_run', 'llm_tokens'], dimensions: null, refreshedAt: REFRESHED_AT },
    { kind: 'agent', source: 'agent_run', period: '2026-09-29', scope: 'user', metricKeys: ['runs'], dimensions: { providers: ['mock'] }, refreshedAt: REFRESHED_AT },
  ],
  layering: { facts: 'deterministic-projection', derived: 'service-computed', interpretation: 'none' },
};

type FetchCall = [RequestInfo | URL, RequestInit | undefined];

function mockApi(options: { role?: 'owner' | 'member'; refreshStatus?: number } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/v1/analytics/overview')) return jsonResponse({ data: OVERVIEW });
    if (url.includes('/api/v1/analytics/breakdown')) return jsonResponse({ data: BREAKDOWN });
    if (url.includes('/api/v1/analytics/sources')) return jsonResponse({ data: SOURCES });
    if (url.includes('/api/v1/analytics/refresh')) {
      if (options.refreshStatus === 403) return jsonResponse({ error: { code: 'FORBIDDEN', message: '无权限' } }, 403);
      return jsonResponse({ data: { organizationId: ORG_ID, from: '2026-09-29', to: '2026-09-29', days: 1, periods: ['2026-09-29'] } });
    }
    if (url.includes('/api/v1/organizations')) {
      return jsonResponse({
        data: [{
          id: ORG_ID, name: '个人空间', slug: 'personal-u1', isPersonal: true, createdAt: REFRESHED_AT,
          members: [{ role: options.role ?? 'owner' }], _count: { members: 1, projects: 0 },
        }],
      });
    }
    throw new Error(`未预期的请求：${url}（${init?.method ?? 'GET'}）`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage(options: Parameters<typeof mockApi>[0] = {}) {
  const fetchMock = mockApi(options);
  renderWithQuery(<ToastProvider><AnalyticsPage /></ToastProvider>);
  await screen.findByRole('heading', { name: '分析' });
  await screen.findByTestId('analytics-derived');
  return fetchMock;
}

const section = (testId: string) => within(screen.getByTestId(testId));

describe('Analytics 页面 · 分层呈现（facts / derived / meta 绝不混排）', () => {
  it('事实区只放 facts 原值（点分键 + 原样数字），不含任何派生指标', async () => {
    await renderPage();
    const facts = section('analytics-facts');
    expect(facts.getByText('事实')).toBeInTheDocument();
    // 原始键直出（含嵌套展开的点分键）
    expect(facts.getByText('llm_tokens')).toBeInTheDocument();
    expect(facts.getByText('1,234')).toBeInTheDocument();
    expect(facts.getByText('durationMsTotal')).toBeInTheDocument();
    expect(facts.getByText('byProvider.mock.failed')).toBeInTheDocument();
    // 派生指标（标签与字段名）绝不出现在事实区
    expect(facts.queryByText('总成本')).toBeNull();
    expect(facts.queryByText('Run 成功率')).toBeNull();
    expect(facts.queryByText('totalCost')).toBeNull();
    expect(facts.queryByText('runSuccessRate')).toBeNull();
  });

  it('派生区只放服务端计算值并带「派生」Badge（含字段名与口径说明）', async () => {
    await renderPage();
    const derived = section('analytics-derived');
    expect(derived.getByText('派生')).toBeInTheDocument();
    expect(derived.getByText('总成本')).toBeInTheDocument();
    expect(derived.getByText('$0.5')).toBeInTheDocument();      // totalCost
    expect(derived.getByText('Run 成功率')).toBeInTheDocument();
    expect(derived.getByText('75%')).toBeInTheDocument();        // runSuccessRate
    expect(derived.getByText('9s')).toBeInTheDocument();         // avgRunDurationMs
    expect(derived.getByText('totalCost')).toBeInTheDocument();  // 字段名如实暴露
    // 事实键绝不混入派生区
    expect(derived.queryByText('llm_tokens')).toBeNull();
    expect(derived.queryByText('durationMsTotal')).toBeNull();
    // 「派生值不是事实源」的口径必须写在页面上
    expect(derived.getByText(/派生值不是事实源/)).toBeInTheDocument();
  });

  it('口径区如实呈现 source / refreshedAt / rows / layering（interpretation=none）', async () => {
    await renderPage();
    const meta = section('analytics-meta');
    expect(meta.getByText('口径')).toBeInTheDocument();
    expect(meta.getByText('agent_run、usage_ledger')).toBeInTheDocument();
    expect(meta.getByText('2026-09-29 09:02')).toBeInTheDocument();
    expect(meta.getByText(/聚合行数 rows/).closest('div')!).toHaveTextContent('5');
    expect(meta.getByText('deterministic-projection')).toBeInTheDocument();
    expect(meta.getByText('service-computed')).toBeInTheDocument();
    expect(meta.getByText('interpretation')).toBeInTheDocument();
    expect(meta.getByText('none')).toBeInTheDocument();
    expect(meta.getByText(`${ORG_ID}`)).toBeInTheDocument();
    expect(meta.getByText(/当日：2026-09-29 → 2026-09-29（1 天）/)).toBeInTheDocument();
  });
});

describe('Analytics 页面 · 分类明细与数据源', () => {
  it('分类明细呈现逐日聚合行（日期/维度/来源表/指标原值）与区间合计', async () => {
    await renderPage();
    const breakdown = section('analytics-breakdown');
    expect(await breakdown.findByText('2026-09-28')).toBeInTheDocument();
    expect(breakdown.getByText('2026-09-29')).toBeInTheDocument();
    expect(breakdown.getAllByText('usage_ledger').length).toBeGreaterThan(0);
    expect(breakdown.getByText(/agent_run 2 · llm_tokens 800/)).toBeInTheDocument();
    expect(breakdown.getByText(/区间合计 facts（2026-08-31 → 2026-09-29）/)).toBeInTheDocument();
  });

  it('切换明细维度会按新 kind 重新取数（kind=agent）', async () => {
    const fetchMock = await renderPage();
    fireEvent.change(screen.getByLabelText('明细维度'), { target: { value: 'agent' } });
    await waitFor(() => {
      const urls = (fetchMock.mock.calls as unknown as FetchCall[]).map(([url]) => String(url));
      expect(urls.some((url) => url.includes('/api/v1/analytics/breakdown?') && url.includes('kind=agent'))).toBe(true);
    });
  });

  it('数据源区呈现 period 行数、kind→source 映射与作用域（组织级/用户级）', async () => {
    await renderPage();
    const sources = section('analytics-sources');
    // usage_ledger 同时出现在 kind→source 映射（值）与来源表（列），故用 getAllByText
    await waitFor(() => expect(sources.getAllByText('usage_ledger').length).toBeGreaterThan(0));
    expect(sources.getByText('组织级')).toBeInTheDocument();
    expect(sources.getByText('用户级')).toBeInTheDocument();
    expect(sources.getByText('agent_run · llm_tokens')).toBeInTheDocument();
    expect(sources.getByText(/聚合行 2 条/)).toBeInTheDocument();
    // 日期输入留空 = 今天（服务端裁定），页面不猜 period
    expect(screen.getByLabelText('数据源日期')).toHaveValue('');
  });
});

describe('Analytics 页面 · 手动刷新（owner 专属写端点 + Toast）', () => {
  it('owner：点击刷新 → POST /analytics/refresh（空体）→ 成功 Toast', async () => {
    const fetchMock = await renderPage({ role: 'owner' });
    expect(screen.getByText(/当前组织角色：owner（可手动刷新）/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '手动刷新聚合' }));
    await waitFor(() => {
      const call = (fetchMock.mock.calls as unknown as FetchCall[]).find(([url]) => String(url).includes('/analytics/refresh'));
      expect(call).toBeDefined();
      expect(call![1]?.method).toBe('POST');
      expect(call![1]?.body).toBe('{}');
    });
    expect(await screen.findByText('聚合刷新完成')).toBeInTheDocument();
    expect(screen.getByText(/2026-09-29 → 2026-09-29（1 天 \/ 1 个周期）/)).toBeInTheDocument();
  });

  it('非 owner：入口禁用并如实说明原因（无 billing.write，服务端会 403）', async () => {
    const fetchMock = await renderPage({ role: 'member' });
    await waitFor(() => expect(screen.getByText(/当前组织角色：member（无 billing.write，服务端将拒绝刷新）/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '手动刷新聚合' })).toBeDisabled();
    expect((fetchMock.mock.calls as unknown as FetchCall[]).some(([url]) => String(url).includes('/analytics/refresh'))).toBe(false);
  });

  it('服务端 403 时如实转述（不乐观更新、不假装成功）', async () => {
    await renderPage({ role: 'owner', refreshStatus: 403 });
    fireEvent.click(screen.getByRole('button', { name: '手动刷新聚合' }));
    expect(await screen.findByText('刷新失败')).toBeInTheDocument();
    expect(screen.getByText(/无权限（手动刷新为组织 owner 专属：billing.write）/)).toBeInTheDocument();
    expect(screen.queryByText('聚合刷新完成')).toBeNull();
  });
});
