import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FeedbackPage from '@/app/feedback/page';
import { ToastProvider } from '@/components/ui/toast';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * /feedback（M13-W6）——反馈（用户主观评价）+ 创意绩效回流（**外部上报事实**）。
 *
 * 钉死的口径：
 *  ① 反馈列表只呈现评分/主体/内容/时间，不把用户评价包装成事实或治理依据；
 *  ② 绩效区呈现「维度 / 窗口 / 结果」，结果只放上报原值（facts）；
 *  ③ 洞察区严格分层：绩效记忆标注「记忆候选」，近期绩效把 facts 与 service-computed 派生值分开渲染；
 *  ④ 录入口径如实披露：该端点任何登录用户可写（归属校验 + 限流），数据 UNTRUSTED，服务端只算比率；
 *  ⑤ 提交反馈/录入绩效都走 useApiMutation（POST 请求体逐字断言）。
 */

const at = (y: number, m: number, d: number, h = 10, min = 30) => new Date(y, m, d, h, min).toISOString();

const FEEDBACK = {
  id: 'fb-1', userId: 'u-1', projectId: null, subjectType: 'artifact', subjectId: 'art-1',
  rating: 4, comment: '配色不错，字重再重一点', createdAt: at(2026, 8, 28),
};

const CREATED = { ...FEEDBACK, id: 'fb-9', subjectId: 'art-9', rating: 4, comment: '挺好' };

const PERFORMANCE = {
  id: 'pf-1', userId: 'u-1', projectId: null, artifactId: 'art-1', campaignId: 'cmp-1', adId: null,
  platform: 'mock', periodStart: '2026-08-30T00:00:00.000Z', periodEnd: '2026-09-29T00:00:00.000Z',
  impressions: 1000, clicks: 50, spend: 10, conversions: 5, revenue: 25, orders: 3, capturedAt: at(2026, 8, 29, 9, 5),
};

const FACTS = { impressions: 1000, clicks: 50, spend: 10, conversions: 5, revenue: 25, orders: 3 };
const DERIVED = { ctr: 0.05, cvr: 0.1, roas: 2.5, cpc: 0.4 };

const INSIGHTS = {
  performanceMemory: [{ id: 'mem-1', content: '创意 art-1 近一期 CTR 5.0% ROAS 2.5（表现好）', status: 'candidate', source: 'memory' }],
  recentPerformance: [{ performanceId: 'pf-1', subject: { artifactId: 'art-1', campaignId: 'cmp-1' }, facts: FACTS, derived: DERIVED, source: 'service-computed' }],
  layering: { performanceMemory: 'memory-candidate', recentPerformance: 'service-computed' },
};

const CAPTURE_RESULT = {
  performanceId: 'pf-9',
  facts: FACTS,
  derived: DERIVED,
  layering: { facts: 'reported', derived: 'service-computed', memory: 'service-rule' },
};

type FetchCall = [RequestInfo | URL, RequestInit | undefined];

function mockApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/feedback/performance/insights')) return jsonResponse({ data: INSIGHTS });
    if (url.includes('/feedback/performance')) {
      return method === 'POST' ? jsonResponse({ data: CAPTURE_RESULT }) : jsonResponse({ data: [PERFORMANCE] });
    }
    if (url.includes('/api/v1/feedback')) {
      return method === 'POST' ? jsonResponse({ data: CREATED }) : jsonResponse({ data: [FEEDBACK] });
    }
    throw new Error(`未预期的请求：${url}（${method}）`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage() {
  const fetchMock = mockApi();
  renderWithQuery(<ToastProvider><FeedbackPage /></ToastProvider>);
  await screen.findByRole('heading', { name: '反馈' });
  await screen.findByTestId('performance-insights');
  return fetchMock;
}

describe('Feedback 页面 · 反馈列表', () => {
  it('呈现评分/主体/内容/时间，并如实标注「用户评价」口径', async () => {
    await renderPage();
    const list = within(screen.getByTestId('feedback-list'));
    expect(await list.findByText('★ 4 / 5')).toBeInTheDocument();
    // 主体类型文案同时出现在筛选下拉的 option 里 → 断言行内（而不是全页唯一）
    expect(within(list.getByText('art-1').closest('tr')!).getByText('制品（artifact）')).toBeInTheDocument();
    expect(list.getByText('配色不错，字重再重一点')).toBeInTheDocument();
    expect(list.getByText('2026-09-28 10:30')).toBeInTheDocument();
    expect(list.getByText('用户评价')).toBeInTheDocument();
    expect(list.getByText(/不作为事实源或自动治理依据/)).toBeInTheDocument();
  });

  it('按主体类型过滤会带 subjectType 重新取数', async () => {
    const fetchMock = await renderPage();
    fireEvent.change(screen.getByLabelText('主体类型筛选'), { target: { value: 'artifact' } });
    await waitFor(() => {
      const urls = (fetchMock.mock.calls as unknown as FetchCall[]).map(([url]) => String(url));
      expect(urls.some((url) => url.includes('/api/v1/feedback?subjectType=artifact'))).toBe(true);
    });
  });
});

describe('Feedback 页面 · 提交反馈（Dialog + useApiMutation）', () => {
  it('填写评分/主体/内容后提交：POST 请求体逐字正确，成功 Toast 且弹窗关闭', async () => {
    const fetchMock = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('主体 ID'), { target: { value: 'art-9' } });
    fireEvent.change(screen.getByLabelText('评分'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: '挺好' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => {
      const call = (fetchMock.mock.calls as unknown as FetchCall[]).find(([url, init]) => String(url).endsWith('/api/v1/feedback') && init?.method === 'POST');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ subjectType: 'artifact', subjectId: 'art-9', rating: 4, comment: '挺好' });
    });
    expect(await screen.findByText('反馈已提交')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('主体 ID 为空时提交按钮禁用（不发出请求）', async () => {
    const fetchMock = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }));
    const submit = screen.getByRole('button', { name: '提交' });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect((fetchMock.mock.calls as unknown as FetchCall[]).filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
});

describe('Feedback 页面 · 性能反馈（外部上报事实）', () => {
  it('呈现维度（平台/制品/活动）、窗口（周期）与结果（上报原值），并标注外部上报', async () => {
    await renderPage();
    const list = within(screen.getByTestId('performance-list'));
    expect(await list.findByText('mock')).toBeInTheDocument();
    expect(list.getByText('artifact art-1 · campaign cmp-1')).toBeInTheDocument();
    expect(list.getByText('2026-08-30 → 2026-09-29')).toBeInTheDocument();
    expect(list.getByText(/impressions 1,000/)).toBeInTheDocument();
    expect(list.getByText(/spend 10/)).toBeInTheDocument();
    expect(list.getByText('外部上报')).toBeInTheDocument();
    expect(list.getByText(/只呈现「上报原值」/)).toBeInTheDocument();
  });
});

describe('Feedback 页面 · 绩效洞察（分层：记忆候选 / 事实 / 派生）', () => {
  it('绩效记忆标注「记忆候选」（含 status 与 layering），不冒充已生效结论', async () => {
    await renderPage();
    const insights = within(screen.getByTestId('performance-insights'));
    expect(await insights.findByText('创意 art-1 近一期 CTR 5.0% ROAS 2.5（表现好）')).toBeInTheDocument();
    expect(insights.getByText('记忆候选')).toBeInTheDocument();
    expect(insights.getByText('candidate')).toBeInTheDocument();
    expect(insights.getByText('layering: memory-candidate')).toBeInTheDocument();
  });

  it('近期绩效把 facts 与 service-computed 派生值分开渲染（派生按比率/倍数/金额展示）', async () => {
    await renderPage();
    const insights = within(screen.getByTestId('performance-insights'));
    expect(await insights.findByText(/clicks 50/)).toBeInTheDocument();
    expect(insights.getByText(/ctr 5%/)).toBeInTheDocument();
    expect(insights.getByText(/cvr 10%/)).toBeInTheDocument();
    expect(insights.getByText(/roas 2.5x/)).toBeInTheDocument();
    expect(insights.getByText(/cpc \$0\.4/)).toBeInTheDocument();
    expect(insights.getAllByText('事实').length).toBeGreaterThan(0);
    expect(insights.getAllByText('派生').length).toBeGreaterThan(0);
  });
});

describe('Feedback 页面 · 录入绩效数据（外部入口，权限如实呈现）', () => {
  it('弹窗内披露「任何登录用户可写 + UNTRUSTED + 只做事实展示」的口径', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '录入绩效数据' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/任何登录用户皆可写/)).toBeInTheDocument();
    expect(dialog.getByText(/限流 30\/分钟/)).toBeInTheDocument();
    expect(dialog.getByText(/外部不可信（UNTRUSTED）/)).toBeInTheDocument();
    expect(dialog.getByText(/不参与策略判定/)).toBeInTheDocument();
  });

  it('录入指标 → POST 请求体逐字正确，并把返回的 facts / derived / layering 分层回显', async () => {
    const fetchMock = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '录入绩效数据' }));

    fireEvent.change(screen.getByLabelText('展示量 impressions'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('点击量 clicks'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('花费 spend'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('转化数 conversions'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('收入 revenue'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('订单数 orders'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'tid' } });
    fireEvent.click(screen.getByRole('button', { name: '录入绩效' }));

    await waitFor(() => {
      const call = (fetchMock.mock.calls as unknown as FetchCall[]).find(([url, init]) => String(url).includes('/feedback/performance') && init?.method === 'POST');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        metrics: { impressions: 1000, clicks: 50, spend: 10, conversions: 5, revenue: 25, orders: 3 },
        platform: 'tid',
      });
    });
    expect(await screen.findByText('绩效事实已录入')).toBeInTheDocument();

    const result = within(await screen.findByTestId('capture-result'));
    expect(result.getByText('pf-9')).toBeInTheDocument();
    // 分层回显：上报事实（reported）与服务端派生分开
    expect(result.getByText('上报事实')).toBeInTheDocument();
    expect(result.getByText('服务端派生')).toBeInTheDocument();
    expect(result.getByText(/facts=reported/)).toBeInTheDocument();
    expect(result.getByText(/derived=service-computed/)).toBeInTheDocument();
    expect(result.getByText(/memory=service-rule/)).toBeInTheDocument();
    expect(result.getByText(/^5%$/)).toBeInTheDocument();      // ctr 0.05 → 5%
    expect(result.getByText(/^2\.5x$/)).toBeInTheDocument();   // roas 2.5 → 2.5x
  });

  it('整数指标字段拒绝小数（与后端 z.number().int() 对齐）：提交按钮禁用', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '录入绩效数据' }));
    fireEvent.change(screen.getByLabelText('展示量 impressions'), { target: { value: '1.5' } });
    expect(screen.getByRole('button', { name: '录入绩效' })).toBeDisabled();
  });
});
