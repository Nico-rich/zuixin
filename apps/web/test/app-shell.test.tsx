import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/app-shell';
import { useToast } from '@/components/ui/toast';
import { NAV_SECTIONS, allNavItems, isNavItemActive } from '@/lib/navigation';
import { jsonResponse, renderWithQuery } from './helpers';

const replaceMock = vi.fn();
let currentPath = '/workflows';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => currentPath,
}));

const ME = { data: { user: { id: 'u1', email: 'admin@example.com', displayName: '管理员', role: 'owner' } } };

function mockApi(me: unknown = ME, meStatus = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/v1/auth/me')) return jsonResponse(me, meStatus);
    throw new Error(`未预期的请求：${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => { currentPath = '/workflows'; replaceMock.mockClear(); });

describe('AppShell 全局导航', () => {
  it('渲染注册表里的全部导航入口（href + 名称），页面 agents 只需改 lib/navigation.ts', async () => {
    mockApi();
    renderWithQuery(<AppShell><p>页面内容</p></AppShell>);

    const nav = await screen.findByRole('navigation', { name: '全局导航' });
    for (const item of allNavItems()) {
      const link = within(nav).getByRole('link', { name: item.label });
      expect(link, `${item.label} 应指向 ${item.href}`).toHaveAttribute('href', item.href);
    }
    expect(screen.getByText('页面内容')).toBeInTheDocument();
  });

  it('导航分组与顺序稳定（工作区 → 能力 → 运营 → 系统）', () => {
    expect(NAV_SECTIONS.map((s) => s.id)).toEqual(['workspace', 'capabilities', 'operations', 'system']);
    // 产品规格要求的左栏顺序（对话/工作流/评测/扩展市场/…/设置）
    expect(allNavItems().map((i) => i.label)).toEqual([
      '首页', '对话', '工作流', '评测', '扩展市场',
      'Agents', 'Agent 运行', '知识库', '记忆', '创意工作台',
      '连接', '分析', '反馈', '用量', '账单', '组织团队',
      '扩展管理', '设置',
    ]);
  });

  it('激活态：分段边界前缀匹配（/chat/abc 命中对话；/agent-runs 不命中 /agents；/workflows 命中）', async () => {
    mockApi();
    renderWithQuery(<AppShell><p>内容</p></AppShell>);
    const nav = await screen.findByRole('navigation', { name: '全局导航' });
    expect(within(nav).getByRole('link', { name: '工作流' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: '对话' })).not.toHaveAttribute('aria-current');

    // 纯函数边界（同一事实源）
    const agents = allNavItems().find((i) => i.label === 'Agents')!;
    const chat = allNavItems().find((i) => i.label === '对话')!;
    const home = allNavItems().find((i) => i.label === '首页')!;
    expect(isNavItemActive(chat, '/chat/abc-123')).toBe(true);
    expect(isNavItemActive(agents, '/agent-runs')).toBe(false);
    expect(isNavItemActive(agents, '/agents/a1')).toBe(true);
    expect(isNavItemActive(home, '/workflows')).toBe(false); // 首页用 exact，避免命中一切
    expect(isNavItemActive(home, '/')).toBe(true);
  });

  it('底部用户区呈现当前用户并可退出；退出后清缓存跳登录页', async () => {
    mockApi();
    renderWithQuery(<AppShell><p>内容</p></AppShell>);
    expect(await screen.findByText('管理员')).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();

    const logout = screen.getByRole('button', { name: '退出登录' });
    logout.click();
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
  });

  it('公开路由（/login）不渲染导航外壳，也不发 /auth/me', async () => {
    currentPath = '/login';
    const fetchMock = mockApi();
    renderWithQuery(<AppShell><p>登录表单</p></AppShell>);

    expect(screen.getByText('登录表单')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '全局导航' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('会话已失效（/auth/me 401）→ 客户端兜底跳登录页', async () => {
    mockApi({ error: { code: 'UNAUTHORIZED', message: '登录已过期' } }, 401);
    renderWithQuery(<AppShell><p>内容</p></AppShell>);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
  });

  it('外壳提供全局 Toast 容器（页面无需自挂 Provider）', async () => {
    mockApi();
    function Probe() {
      const { toast } = useToast();
      return <button onClick={() => toast({ title: '已保存', variant: 'success' })}>触发提示</button>;
    }
    renderWithQuery(<AppShell><Probe /></AppShell>);
    screen.getByRole('button', { name: '触发提示' }).click();
    expect(await screen.findByText('已保存')).toBeInTheDocument();
  });
});

/**
 * 结构约束回归（这些约束来自既有 e2e 的选择器口径，破坏它们会静默改掉别人的测试语义）：
 *  - 只读页 e2e 用 `ul > li` 判定页面列表行 → 外壳不得出现 ul>li；
 *  - evaluation e2e 用「section + 同名 heading」唯一定位分区 → 外壳不得有 section/heading；
 *  - chat e2e 用 `div.group` 定位助手气泡 → 外壳不得用 group class；
 *  - 只读页 e2e 断言无写操作按钮（正则含 新建/删除/创建/运行/发布/保存/提交/安装/导入/上传）→ 外壳按钮名不得命中。
 */
describe('AppShell 结构约束（e2e 选择器口径）', () => {
  it('不含 ul>li、section、heading、group class，且无写操作按钮', async () => {
    mockApi();
    const { container } = renderWithQuery(<AppShell><p>内容</p></AppShell>);
    await screen.findByRole('navigation', { name: '全局导航' });

    const shell = container.querySelector('aside')!.parentElement!;
    expect(shell.querySelectorAll('ul li')).toHaveLength(0);
    expect(shell.querySelectorAll('section')).toHaveLength(0);
    expect(shell.querySelectorAll('h1,h2,h3,h4,h5,h6')).toHaveLength(0);
    expect(shell.querySelectorAll('.group')).toHaveLength(0);

    const writeButton = /安装|发布|删除|创建|新建|运行|保存|提交|导入|上传/;
    const buttons = Array.from(shell.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    expect(buttons.filter((name) => writeButton.test(name))).toEqual([]);
  });
});
