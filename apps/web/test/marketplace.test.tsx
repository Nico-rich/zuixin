import { Suspense } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MarketplacePage from '@/app/marketplace/page';
import MarketplaceDetailPage from '@/app/marketplace/[id]/page';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * M9-P6 Marketplace UI（公开目录）：
 * - 列表页：搜索/分类过滤入参与条目呈现（评分均值+条数、安装量、发布者、平台级/组织私有）；
 * - 详情页：评分分布 / 安装量 / **权限披露**（声明权限、清单请求 vs 平台实际授予、被剔除项与原因、
 *   被包装 baseTool）/ changelog；
 * - 管理入口按 viewer 能力显隐（服务端 RBAC 才是裁决方，本页不做权限判定）。
 */

const ITEM = {
  id: 'pub-1',
  status: 'published',
  category: 'knowledge',
  description: '面向组织知识库的只读检索扩展',
  publisher: { organizationId: 'org-1', organizationName: '市场测试组织', displayName: '管理员', organizationSlug: 'o' },
  extension: { id: 'ext-1', name: '市场检索扩展', slug: 'mkt-tool', kind: 'tool', scope: 'organization', description: null, status: 'published' },
  publishedVersion: { id: 'v1', version: 1, checksum: 'a'.repeat(64), createdAt: '2026-09-28T00:00:00.000Z' },
  rating: { average: 4.5, count: 2, distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 } },
  installCount: 3,
};

const DISCLOSURE = {
  readOnly: true,
  kind: 'agent',
  policy: '权限 = manifest 声明 ∩ 平台权限白名单 ∩ 平台工具注册表 ∩ 组织策略；评分/审核状态/安装量均不参与授权',
  declaredPermissions: [{ name: 'agent.run', scope: 'organization', description: '创建并运行扩展 Agent（平台 Agent 体系）' }],
  requestedTools: ['knowledge.search', 'external_action.execute'],
  effectiveTools: ['knowledge.search'],
  droppedTools: [{ name: 'external_action.execute', reason: 'tool_permission_not_wrappable', detail: '工具权限面 external_action 不在扩展可获得面' }],
  wrappedTool: null,
};

const DETAIL = {
  ...ITEM,
  publishedVersion: ITEM.publishedVersion,
  changelog: [{ version: '1.0.0', notes: '首个版本' }],
  compatibility: { minPlatformVersion: '1.0.0', notes: '需要 M8 及以上平台' },
  permissionDisclosure: DISCLOSURE,
  reviews: [
    { id: 'rv-1', userId: 'u2', rating: 5, body: '检索很快', moderationStatus: 'approved', createdAt: '2026-09-28T01:00:00.000Z', reviewer: { userId: 'u2', displayName: '评审者乙' } },
  ],
  viewer: { role: 'owner', platformAdmin: false, canManage: true, canModerate: true, myReview: null },
};

const EMPTY_VIEWER = { role: null, platformAdmin: false, canManage: false, canModerate: false, myReview: null };

function mockApi(detail: unknown = DETAIL) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/marketplace/categories')) {
      return jsonResponse({ data: [{ category: 'knowledge', publishedCount: 1 }, { category: 'finance', publishedCount: 0 }] });
    }
    if (url.includes('/reviews')) return jsonResponse({ data: [] });
    if (url.includes('/marketplace/publications/')) return jsonResponse({ data: detail });
    if (url.includes('/marketplace/publications')) {
      return jsonResponse({ data: { items: [ITEM], total: 1, page: 1, limit: 20, totalPages: 1 } });
    }
    throw new Error(`未预期的请求：${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderDetail(detail: unknown = DETAIL) {
  mockApi(detail);
  await act(async () => {
    renderWithQuery(
      <Suspense fallback={<p>页面加载中…</p>}>
        <MarketplaceDetailPage params={Promise.resolve({ id: 'pub-1' })} />
      </Suspense>,
    );
  });
  await screen.findByRole('heading', { name: '市场检索扩展' });
}

describe('Marketplace 列表页', () => {
  it('呈现已上架条目：评分均值+条数、安装量、发布者、分类过滤选项', async () => {
    const fetchMock = mockApi();
    renderWithQuery(<MarketplacePage />);
    await screen.findByRole('heading', { name: '扩展市场' });

    const link = await screen.findByRole('link', { name: /市场检索扩展/ });
    expect(link).toHaveAttribute('href', '/marketplace/pub-1');
    expect(within(link).getByText('市场测试组织')).toBeInTheDocument();
    expect(within(link).getByText(/安装 3/)).toBeInTheDocument();
    expect(within(link).getByText(/★ 4.50（2）/)).toBeInTheDocument();
    // 分类下拉来自白名单接口（含计数）
    expect(screen.getByRole('option', { name: 'knowledge（1）' })).toBeInTheDocument();
    // 默认只查公开面（status 参数不出现 —— published 是服务端默认）
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/marketplace/publications?'))).toBe(true);
  });

  it('搜索/分类入参按用户输入拼接（q 与 category，且不带 status —— 公开面由服务端裁定）', async () => {
    const fetchMock = mockApi();
    renderWithQuery(<MarketplacePage />);
    await screen.findByRole('heading', { name: '扩展市场' });

    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '品牌' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('q=%E5%93%81%E7%89%8C'))).toBe(true);
    });

    fireEvent.change(screen.getByLabelText('分类'), { target: { value: 'knowledge' } });
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('q=%E5%93%81%E7%89%8C') && u.includes('category=knowledge'))).toBe(true);
    });
    // 列表页从不请求非公开面
    expect(fetchMock.mock.calls.map(([u]) => String(u)).every((u) => !u.includes('status='))).toBe(true);
  });
});

describe('Marketplace 详情页（评分/安装量/权限披露/changelog）', () => {
  it('评分分布、安装量、校验和与 changelog 如实呈现', async () => {
    await renderDetail();
    expect(screen.getByText('★ 4.50')).toBeInTheDocument();
    expect(screen.getByText('（2 条通过审核）')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument(); // 安装量
    expect(screen.getByText(/aaaaaaaaaaaaaaaa…/)).toBeInTheDocument(); // checksum 前缀（不整体回显）
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    expect(screen.getByText('首个版本')).toBeInTheDocument();
    expect(screen.getByText(/平台 ≥ 1.0.0/)).toBeInTheDocument();
    expect(screen.getByText('检索很快')).toBeInTheDocument();
  });

  it('权限披露：口径文案 + 声明权限 + 清单请求/平台实际授予 + 被剔除项与原因', async () => {
    await renderDetail();
    const section = screen.getByRole('heading', { name: '权限披露' }).closest('section')!;
    expect(within(section).getByText(/评分\/审核状态\/安装量均不参与授权/)).toBeInTheDocument();
    expect(within(section).getByText('agent.run')).toBeInTheDocument();
    // knowledge.search 出现两次 = 既是清单请求项，也是平台实际授予项（两侧同时呈现才叫披露）
    expect(within(section).getAllByText('knowledge.search')).toHaveLength(2);
    expect(within(section).getAllByText('external_action.execute')).toHaveLength(2); // 请求项 + 被剔除项
    expect(within(section).getByText('（tool_permission_not_wrappable）')).toBeInTheDocument();
    // 披露对象是展示投影：页面必须标注不可据此授权
    expect(within(section).getByText(/均不参与授权/)).toBeInTheDocument();
  });

  it('tool 类扩展：披露被包装的 baseTool 与可包装性', async () => {
    await renderDetail({
      ...DETAIL,
      permissionDisclosure: {
        ...DISCLOSURE, kind: 'tool', requestedTools: [], effectiveTools: [], droppedTools: [],
        wrappedTool: { name: 'ext.mkt-tool.search', baseTool: 'knowledge.search', baseToolPermission: 'read', wrappable: true },
      },
    });
    const section = screen.getByRole('heading', { name: '权限披露' }).closest('section')!;
    expect(within(section).getByText('ext.mkt-tool.search')).toBeInTheDocument();
    expect(within(section).getByText('knowledge.search')).toBeInTheDocument();
    expect(within(section).getByText(/权限 read，可包装/)).toBeInTheDocument();
  });

  it('管理入口按 viewer 能力显隐：有管理权的 owner 看到撤回与审核队列', async () => {
    await renderDetail();
    expect(screen.getByRole('button', { name: '撤回' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /评审审核 · 待审/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '驳回下架' })).toBeDisabled(); // 无理由 → 不可提交
  });

  it('只读访客（非成员）：无任何管理/审核入口，仅展示', async () => {
    await renderDetail({ ...DETAIL, viewer: EMPTY_VIEWER });
    expect(screen.queryByRole('button', { name: '撤回' })).toBeNull();
    expect(screen.queryByRole('button', { name: '驳回下架' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /评审审核 · 待审/ })).toBeNull();
    expect(screen.getByRole('heading', { name: '权限披露' })).toBeInTheDocument();
  });

  it('未上架条目（草稿）：发布者可见「上架」入口，且不显示评分表单', async () => {
    await renderDetail({ ...DETAIL, status: 'draft', viewer: { ...DETAIL.viewer, canModerate: false } });
    expect(screen.getByRole('button', { name: '上架' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提交评分' })).toBeNull(); // 仅已上架条目可评分
  });
});
