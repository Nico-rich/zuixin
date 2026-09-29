import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DashboardPage from '@/app/page';
import { AppShell } from '@/components/app-shell';
import {
  OVERVIEW_PATH, RECENT_CONVERSATIONS_KEY, RECENT_LIMIT, RECENT_PATH, formatDateTime, formatRelativeTime,
} from '@/lib/dashboard';
import { conversationKeys } from '@/lib/services/conversations';
import { jsonResponse, renderWithQuery } from './helpers';

/** 外壳里的 usePathname：Dashboard 落地在 `/`（本文件只给这一条路径） */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

/**
 * M13-W8 Dashboard 首页（/ 替换 redirect('/chat')）
 *
 * 断言口径：
 *  - 概览卡片**只**渲染 analytics overview 的 facts 区，且逐卡标注「事实」徽标；
 *    derived（服务端派生）绝不出现在本页——这是 roadmap §4 的 facts/derived 分层红线；
 *  - 最近会话来自 /conversations 列表（事务表行），点击进入 /chat/[id]；
 *  - 四种数据面状态（加载骨架 / 就绪 / 空态 / 无权限 / 失败重试）都有确定性覆盖；
 *  - 查询键与聊天侧栏隔离（同一条缓存被两处复用会让 5 条结果污染侧栏的 50 条列表）。
 */

const ME = { data: { user: { id: 'u1', email: 'admin@example.com', displayName: '管理员', role: 'owner' } } };

const NOW = Date.now();

/** 会话列表（服务端 updatedAt desc + limit=RECENT_LIMIT → 这里就给同样条数，第 i 条「i 分钟前」更新） */
const CONVERSATIONS = [1, 2, 3, 4, 5].slice(0, RECENT_LIMIT).map((i) => ({
  id: `c${i}`,
  title: `会话 ${i}`,
  projectId: null,
  createdAt: new Date(NOW - i * 3_600_000).toISOString(),
  updatedAt: new Date(NOW - i * 60_000).toISOString(),
}));

/** overview 事实区（含刻意夸张的 derived 值：它们一旦出现在页面上就是分层红线的破坏） */
const OVERVIEW = {
  organizationId: 'personal-u1',
  range: 'day',
  from: '2026-09-29',
  to: '2026-09-29',
  days: 1,
  facts: {
    usage: {
      agent_run: 4, llm_tokens: 1234, llm_cost: 2.5, image_generation: 3,
      video_seconds: 12, external_api_call: 0, workflow_run: 2, entries: 9,
    },
    agent: { runs: 7, completed: 6, failed: 1, durationMsTotal: 9000, durationSamples: 6 },
    generation: { tasks: 3, imageSucceeded: 3 },
    workflow: { runs: 2, completed: 2 },
  },
  context: { members: 2 },
  // 派生值：不是事实源 → 本页不得渲染（要看去 /analytics）
  derived: {
    totalCost: 987654.321, llmCost: 2.5, providerCost: 3, runSuccessRate: 0.857143,
    avgRunDurationMs: 1500, costPerRun: 0.75, costPerMember: 1.5, costPerDay: 3,
    runsPerDay: 7, imagesPerDay: 3, workflowSuccessRate: 1,
  },
  meta: {
    source: ['usage_ledger', 'agent_run', 'workflow_run'],
    refreshedAt: '2026-09-29T12:30:00.000Z',
    rows: 3,
    layering: { facts: 'deterministic-projection', derived: 'service-computed', interpretation: 'none' },
  },
};

interface Stubs {
  me?: () => Response;
  overview?: () => Response;
  conversations?: () => Response;
}

/** 路由式 fetch 桩（与 app-shell 测试同一风格：未预期请求直接抛错，绝不静默兜底） */
function mockApi(stubs: Stubs = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/v1/auth/me')) return (stubs.me ?? (() => jsonResponse(ME)))();
    if (url.includes('/api/v1/analytics/overview')) return (stubs.overview ?? (() => jsonResponse({ data: OVERVIEW })))();
    if (url.includes('/api/v1/conversations')) return (stubs.conversations ?? (() => jsonResponse({ data: CONVERSATIONS })))();
    throw new Error(`未预期的请求：${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const requestedUrls = (fetchMock: ReturnType<typeof mockApi>) => fetchMock.mock.calls.map((c) => String(c[0]));

describe('Dashboard 欢迎区', () => {
  it('展示当前用户姓名（/auth/me 与 AppShell 共用缓存），加载期先给骨架', async () => {
    mockApi();
    const { container } = renderWithQuery(<DashboardPage />);

    // 加载态：骨架（Skeleton 无文字，故用结构断言；页面上不得出现「加载中…」这类会污染 e2e 的文案）
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText('加载中…')).toBeNull();

    expect(await screen.findByRole('heading', { name: '你好，管理员' })).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0));
  });

  it('会话失效（/auth/me 401）→ 不崩：退化为通用问候（跳登录由 AppShell 负责）', async () => {
    mockApi({ me: () => jsonResponse({ error: { code: 'UNAUTHORIZED', message: '登录已过期' } }, 401) });
    renderWithQuery(<DashboardPage />);
    expect(await screen.findByRole('heading', { name: '你好，欢迎回来' })).toBeInTheDocument();
  });
});

describe('Dashboard 概览卡片（facts 区 + 「事实」徽标）', () => {
  it('请求口径：range=day 且不带 organizationId（服务端解析组织归属）', async () => {
    const fetchMock = mockApi();
    renderWithQuery(<DashboardPage />);
    await screen.findByText('LLM Tokens');

    const urls = requestedUrls(fetchMock);
    expect(urls).toContain(OVERVIEW_PATH);
    expect(OVERVIEW_PATH).toBe('/api/v1/analytics/overview?range=day');
    expect(urls.some((u) => u.includes('organizationId'))).toBe(false);
    expect(urls).toContain(RECENT_PATH);
    expect(RECENT_PATH).toBe('/api/v1/conversations?limit=5');
  });

  it('渲染 facts 值并逐卡标注「事实」；derived（派生值）绝不出现在页面上', async () => {
    mockApi();
    renderWithQuery(<DashboardPage />);
    await screen.findByText('LLM Tokens');

    // 组织用量（facts.usage）
    expect(screen.getByText('1,234')).toBeInTheDocument(); // llm_tokens
    expect(screen.getByText('2.5')).toBeInTheDocument(); // llm_cost（账本口径）
    expect(screen.getByText('12')).toBeInTheDocument(); // video_seconds
    // 近期活动（facts.agent / facts.workflow）
    expect(screen.getByText('7')).toBeInTheDocument(); // agent.runs
    expect(screen.getByText('6 / 1')).toBeInTheDocument(); // completed / failed
    expect(screen.getByText('工作流运行')).toBeInTheDocument();

    // 徽标：两张事实卡（组织用量 / 近期活动）+ 一张会话列表卡（事务表行，不冒充聚合事实）
    expect(screen.getAllByText('事实')).toHaveLength(2);
    expect(screen.getByText('会话列表')).toBeInTheDocument();

    // 分层红线：derived 不是事实源 → 页面不得出现（含 totalCost / runSuccessRate 等）
    expect(screen.queryByText(/987654/)).toBeNull();
    expect(screen.queryByText(/0\.857143/)).toBeNull();

    // 来源与新鲜度如实呈现（analytics service 契约要求）
    expect(screen.getByText(/事实来源：usage_ledger、agent_run、workflow_run/)).toBeInTheDocument();
    expect(screen.getByText(/刷新于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)).toBeInTheDocument();
  });

  it('聚合行尚未生成（facts 为空对象）→ 两张事实卡各自给空态，不是 0 也不是错误', async () => {
    const empty = { ...OVERVIEW, facts: {}, meta: { ...OVERVIEW.meta, source: [], refreshedAt: null, rows: 0 } };
    mockApi({ overview: () => jsonResponse({ data: empty }) });
    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText('今日暂无用量事实（聚合行尚未生成）')).toBeInTheDocument();
    expect(screen.getByText('今日暂无运行活动（聚合行尚未生成）')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('无权限（403 FORBIDDEN）→ 空态告知，不提供点了也没用的「重试」', async () => {
    mockApi({ overview: () => jsonResponse({ error: { code: 'FORBIDDEN', message: '需要组织成员权限' } }, 403) });
    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText('无权查看组织用量（分析读面要求组织成员权限）')).toBeInTheDocument();
    expect(screen.getByText('无权查看运行活动（分析读面要求组织成员权限）')).toBeInTheDocument();
    expect(screen.queryByText('组织用量加载失败')).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('概览失败（非权限错误）→ 错误态 + 重试；重试成功后渲染事实值', async () => {
    let attempt = 0;
    const fetchMock = mockApi({
      overview: () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse({ error: { code: 'INTERNAL', message: '聚合读取失败' } }, 500)
          : jsonResponse({ data: OVERVIEW });
      },
    });
    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText('组织用量加载失败')).toBeInTheDocument();
    const retries = screen.getAllByRole('button', { name: '重试' });
    fireEvent.click(retries[0]!);

    expect(await screen.findByText('LLM Tokens')).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    await waitFor(() => expect(requestedUrls(fetchMock).filter((u) => u.includes('analytics/overview')).length).toBe(2));
  });
});

describe('Dashboard 最近会话', () => {
  it('前 5 条按服务端顺序呈现，点击进入 /chat/[id]', async () => {
    mockApi();
    renderWithQuery(<DashboardPage />);
    await screen.findByText('最近会话');

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1); // 去掉表头行
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => within(r).getByRole('link').textContent)).toEqual(
      ['会话 1', '会话 2', '会话 3', '会话 4', '会话 5'],
    );
    for (const i of [1, 2, 3, 4, 5]) {
      expect(within(table).getByRole('link', { name: `会话 ${i}` })).toHaveAttribute('href', `/chat/c${i}`);
    }
    // 相对时间（updatedAt desc 的第 1 条 = 1 分钟前）
    expect(within(rows[0]!).getByText('1 分钟前')).toBeInTheDocument();
    // 「活跃会话」卡片的计数来自同一份列表数据
    expect(screen.getByText('5 条')).toBeInTheDocument();
  });

  it('空态：给出新建对话引导（链接到 /chat）', async () => {
    mockApi({ conversations: () => jsonResponse({ data: [] }) });
    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText(/还没有会话，去/)).toBeInTheDocument();
    expect(screen.getByText('还没有会话')).toBeInTheDocument(); // 活跃会话卡片空态
    const newChat = screen.getAllByRole('link', { name: '新建对话' });
    expect(newChat.some((l) => l.getAttribute('href') === '/chat')).toBe(true);
  });

  it('失败 → 错误态 + 重试；重试成功后列表出现（且不残留错误文案）', async () => {
    let attempt = 0;
    mockApi({
      conversations: () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse({ error: { code: 'INTERNAL', message: '列表读取失败' } }, 500)
          : jsonResponse({ data: CONVERSATIONS });
      },
    });
    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText('最近会话加载失败')).toBeInTheDocument();
    expect(screen.getByText('会话列表加载失败')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByRole('link', { name: '会话 1' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('最近会话加载失败')).toBeNull());
    expect(screen.queryByText('会话列表加载失败')).toBeNull();
  });

  it('查询键与聊天侧栏隔离（同键会让 5 条结果污染侧栏的 50 条列表），并保留 invalidate 前缀语义', () => {
    expect([...RECENT_CONVERSATIONS_KEY]).not.toEqual([...conversationKeys.list(null)]);
    // ['conversations', undefined] 与 ['conversations', null] 在 React Query 里哈希相同 → 必须避开
    expect(JSON.stringify(RECENT_CONVERSATIONS_KEY)).not.toBe(JSON.stringify(['conversations', undefined]));
    expect(RECENT_CONVERSATIONS_KEY[0]).toBe(conversationKeys.all[0]); // 前缀 = ['conversations'] → 失效可命中
    expect([...RECENT_CONVERSATIONS_KEY].slice(0, conversationKeys.all.length)).toEqual([...conversationKeys.all]);
  });
});

describe('Dashboard 与全局外壳（导航落地）', () => {
  it('路径为 / 时导航「首页」高亮、「对话」仍指向 /chat（对话默认页不变）', async () => {
    mockApi();
    renderWithQuery(<AppShell><DashboardPage /></AppShell>);

    const nav = await screen.findByRole('navigation', { name: '全局导航' });
    expect(within(nav).getByRole('link', { name: '首页' })).toHaveAttribute('aria-current', 'page');
    const chat = within(nav).getByRole('link', { name: '对话' });
    expect(chat).toHaveAttribute('href', '/chat');
    expect(chat).not.toHaveAttribute('aria-current');
    // 外壳 + 页面同框：欢迎区与最近会话都在（Dashboard 真实落地，不再是 redirect）
    expect(await screen.findByRole('heading', { name: '你好，管理员' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: '会话 1' })).toBeInTheDocument();
  });
});

describe('Dashboard 快速入口', () => {
  it('四个入口卡链接到对应路由（/chat 仍是对话默认页）', async () => {
    mockApi();
    renderWithQuery(<DashboardPage />);
    await screen.findByText('快速入口');

    const expected: Array<[string, string]> = [
      ['新建对话', '/chat'],
      ['工作流', '/workflows'],
      ['评测', '/evaluation'],
      ['创意工作台', '/creative'],
    ];
    for (const [label, href] of expected) {
      expect(screen.getByRole('link', { name: new RegExp(`^${label}`) }), `${label} → ${href}`).toHaveAttribute('href', href);
    }
  });
});

describe('Dashboard 时间格式化（纯函数）', () => {
  it('相对时间：刚刚 / 分钟 / 小时 / 超过一天给 UTC 日期', () => {
    const now = Date.parse('2026-09-29T12:00:00.000Z');
    const at = (offsetMs: number) => new Date(now - offsetMs).toISOString();
    expect(formatRelativeTime(at(30_000), now)).toBe('刚刚');
    expect(formatRelativeTime(at(5 * 60_000), now)).toBe('5 分钟前');
    expect(formatRelativeTime(at(3 * 3_600_000), now)).toBe('3 小时前');
    expect(formatRelativeTime(at(50 * 3_600_000), now)).toBe('2026-09-27');
    expect(formatRelativeTime('not-a-date', now)).toBe('—');
  });

  it('绝对时间：本地时区分钟精度；缺失给破折号（绝不显示 Invalid Date）', () => {
    expect(formatDateTime('2026-09-29T12:30:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('')).toBe('—');
    expect(formatDateTime('2026-13-99')).toBe('—');
  });
});
