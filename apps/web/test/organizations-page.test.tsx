import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OrganizationsPage from '@/app/organizations/page';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * /organizations（M13-W5）：我所属的组织列表 + 建组织 + 用邀请 token 加入。
 *
 * 覆盖点：
 *  - 归属纪律（路线图 §4）：列表与「我的角色」只来自 `GET /organizations` 的服务端返回
 *    （`members[0].role` 是调用者自己的成员行）；服务端没给角色就显示「非成员」，页面绝不推断；
 *  - 建组织：POST body 只带 name/slug（slug 留空则不带字段，服务端生成），标识格式在前端只做**抑制无效提交**；
 *  - 接受邀请：token 是**路径参数**，必须整体 URL 编码（否则 hostile token 能逃出路径）；
 *  - 错误一律如实展示服务端 code + message。
 */

const CREATED_AT = '2026-09-01T00:00:00.000Z';

const ORGS = {
  data: [
    { id: 'org-1', name: '个人空间', slug: 'personal-u1', isPersonal: true, createdAt: CREATED_AT, members: [{ role: 'owner' }], _count: { members: 1, projects: 2 } },
    { id: 'org-2', name: '团队 A', slug: 'team-a', isPersonal: false, createdAt: '2026-09-02T00:00:00.000Z', members: [{ role: 'admin' }], _count: { members: 3, projects: 1 } },
    // 服务端未给出调用者的成员行 → 页面不得自行假定角色
    { id: 'org-3', name: '未知归属', slug: 'no-role', isPersonal: false, createdAt: '2026-09-03T00:00:00.000Z', members: [], _count: { members: 4, projects: 0 } },
  ],
};

interface State {
  orgs: Array<Record<string, unknown>>;
  createStatus?: number;
  acceptStatus?: number;
}

function mockApi(state: State = { orgs: ORGS.data }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url === '/api/v1/organizations' && method === 'GET') return jsonResponse({ data: state.orgs });

    if (url === '/api/v1/organizations' && method === 'POST') {
      if (state.createStatus) {
        return jsonResponse({ error: { code: 'FORBIDDEN', message: '权限不足' } }, state.createStatus);
      }
      const body = JSON.parse(String(init?.body)) as { name: string; slug?: string };
      const created = {
        id: 'org-9', name: body.name, slug: body.slug ?? 'auto-generated', isPersonal: false,
        createdAt: '2026-09-29T00:00:00.000Z', members: [{ role: 'owner' }], _count: { members: 1, projects: 0 },
      };
      state.orgs = [...state.orgs, created];
      return jsonResponse({ data: created }, 201);
    }

    if (method === 'POST' && url.startsWith('/api/v1/invitations/') && url.endsWith('/accept')) {
      if (state.acceptStatus) {
        return jsonResponse({ error: { code: 'NOT_FOUND', message: '邀请不存在' } }, state.acceptStatus);
      }
      return jsonResponse({ data: { organizationId: 'org-2', role: 'member' } }, 201);
    }

    throw new Error(`未预期的请求：${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage(state: State = { orgs: ORGS.data }) {
  const fetchMock = mockApi(state);
  renderWithQuery(<OrganizationsPage />);
  await screen.findByRole('link', { name: '团队 A' });
  return fetchMock;
}

describe('/organizations 列表（归属/角色只信服务端）', () => {
  it('逐行呈现名称链接、标识、类型与**服务端返回的我的角色**', async () => {
    await renderPage();
    const row = screen.getByRole('link', { name: '团队 A' }).closest('tr')!;

    expect(within(row).getByRole('link', { name: '团队 A' })).toHaveAttribute('href', '/organizations/org-2');
    expect(within(row).getByText('team-a')).toBeInTheDocument();
    expect(within(row).getByText('团队')).toBeInTheDocument();
    expect(within(row).getByText('admin')).toBeInTheDocument();
    expect(within(row).getByText('3')).toBeInTheDocument(); // 成员数
    expect(within(row).getByText('1')).toBeInTheDocument(); // 项目数

    const personal = screen.getByRole('link', { name: '个人空间' }).closest('tr')!;
    expect(within(personal).getByText('个人')).toBeInTheDocument();
    expect(within(personal).getByText('owner')).toBeInTheDocument();
  });

  it('服务端未返回调用者的成员行 → 显示「非成员」，页面不推断角色', async () => {
    await renderPage();
    const row = screen.getByRole('link', { name: '未知归属' }).closest('tr')!;
    expect(within(row).getByText('非成员')).toBeInTheDocument();
    expect(within(row).queryByText('owner')).toBeNull();
  });

  it('空态/加载失败：明确提示 + 服务端 message 原样呈现', async () => {
    mockApi({ orgs: [] });
    renderWithQuery(<OrganizationsPage />);
    expect(await screen.findByText('暂无组织')).toBeInTheDocument();
  });

  it('列表失败（500）：code + message 原样呈现', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'INTERNAL', message: '数据库不可用' } }, 500)));
    renderWithQuery(<OrganizationsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('组织列表加载失败：数据库不可用（INTERNAL）');
  });
});

describe('/organizations 创建组织', () => {
  it('POST body 只带 name/slug；成功后提示 + 失效重取（新组织出现在列表中）', async () => {
    const fetchMock = await renderPage();
    fireEvent.change(screen.getByLabelText('组织名称'), { target: { value: '团队 B' } });
    fireEvent.change(screen.getByLabelText('组织标识'), { target: { value: 'team-b' } });
    fireEvent.click(screen.getByRole('button', { name: '创建组织' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/v1/organizations' && i?.method === 'POST');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ name: '团队 B', slug: 'team-b' });
    });
    expect(await screen.findByRole('status')).toHaveTextContent('组织已创建：团队 B（team-b）');
    expect(await screen.findByRole('link', { name: '团队 B' })).toBeInTheDocument(); // 服端事实为准的重新拉取
  });

  it('标识留空则不带 slug 字段（由服务端生成）', async () => {
    const fetchMock = await renderPage();
    fireEvent.change(screen.getByLabelText('组织名称'), { target: { value: '无标识组织' } });
    fireEvent.click(screen.getByRole('button', { name: '创建组织' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/v1/organizations' && i?.method === 'POST');
      expect(JSON.parse(String(call![1]?.body))).toEqual({ name: '无标识组织' });
    });
  });

  it('标识不合规：提示格式并禁止提交（前端只做无效提交拦截，最终由服务端裁决）', async () => {
    const fetchMock = await renderPage();
    fireEvent.change(screen.getByLabelText('组织名称'), { target: { value: '团队 C' } });
    fireEvent.change(screen.getByLabelText('组织标识'), { target: { value: '团队 C' } });

    expect(screen.getByText(/标识需匹配 \^\[a-z0-9-\]\{3,50\}/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建组织' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '创建组织' }));
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
  });

  it('创建被服务端拒绝（403 FORBIDDEN）：如实呈现', async () => {
    await renderPage({ orgs: ORGS.data, createStatus: 403 });
    fireEvent.change(screen.getByLabelText('组织名称'), { target: { value: '团队 D' } });
    fireEvent.click(screen.getByRole('button', { name: '创建组织' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('创建组织失败：权限不足（FORBIDDEN）');
  });
});

describe('/organizations 接受邀请（token 走路径参数）', () => {
  it('POST /invitations/:token/accept（token 整体 URL 编码）→ 提示加入结果 + 失效重取', async () => {
    const fetchMock = await renderPage();
    fireEvent.change(screen.getByLabelText('邀请 token'), { target: { value: 'a1b2c3d4' } });
    fireEvent.click(screen.getByRole('button', { name: '接受邀请' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/v1/invitations/a1b2c3d4/accept')).toBe(true));
    expect(await screen.findByRole('status')).toHaveTextContent('已加入组织 org-2（角色 member）');
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u, i]) => String(u) === '/api/v1/organizations' && (i?.method ?? 'GET') === 'GET').length).toBeGreaterThanOrEqual(2));
  });

  it('hostile token 不会逃出路径（encodeURIComponent 后作为单个路径段）', async () => {
    const fetchMock = await renderPage();
    const hostile = '../../organizations/org-2?x=1#frag';
    fireEvent.change(screen.getByLabelText('邀请 token'), { target: { value: hostile } });
    fireEvent.click(screen.getByRole('button', { name: '接受邀请' }));

    await waitFor(() => {
      const url = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.startsWith('/api/v1/invitations/'));
      expect(url).toBe(`/api/v1/invitations/${encodeURIComponent(hostile)}/accept`);
    });
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/v1/organizations/org-2?x=1')).toBe(false);
  });

  it('邀请不存在（404 NOT_FOUND）：如实呈现服务端 message', async () => {
    await renderPage({ orgs: ORGS.data, acceptStatus: 404 });
    fireEvent.change(screen.getByLabelText('邀请 token'), { target: { value: 'deadbeef' } });
    fireEvent.click(screen.getByRole('button', { name: '接受邀请' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('接受邀请失败：邀请不存在（NOT_FOUND）');
  });
});
