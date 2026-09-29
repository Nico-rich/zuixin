import { Suspense } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OrganizationDetailPage from '@/app/organizations/[id]/page';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * /organizations/[id]（M13-W5）：组织详情与团队管理。
 *
 * 覆盖点：
 *  - **RBAC 如实呈现**（路线图 §4）：角色只来自服务端（列表里的 `members[0].role`），页面据此显隐；
 *    服务端 403 FORBIDDEN / ORG_DISABLED 一律以 code + message 原样呈现，前端不吞错、不降级成「操作失败」；
 *  - 后端硬规则照实呈现：owner 行不可移除（须保留 owner）、个人空间不可删除/不可 owner 自助禁用、
 *    禁用态下组织级读全部 403 → 页面只剩「启用」入口；
 *  - 写路径的参数/路径：PATCH 名称、DELETE 成员、POST 邀请（email 小写）、POST 撤销邀请（token 编码）。
 *
 * 服务的真实 RBAC（apps/api authorization.service.ts 矩阵，前端只做显隐）：
 *  organization.read = 全部成员；organization.write = owner；member.read/write = owner/admin（member 可读）。
 */

const ORG_ID = 'org-2';
const ME = { data: { user: { id: 'u-1', email: 'me@example.com', displayName: '我', role: 'user' } } };
const ME_ADMIN = { data: { user: { id: 'u-1', email: 'me@example.com', displayName: '我', role: 'admin' } } };

const PENDING_TOKEN = 'a'.repeat(48);
const ACCEPTED_TOKEN = 'b'.repeat(48);

type Role = 'owner' | 'admin' | 'member' | 'viewer';

interface State {
  /** 调用者在 org-2 的角色（服务端返回 → 页面只据此显隐） */
  role: Role;
  platformAdmin: boolean;
  isPersonal: boolean;
  status: 'active' | 'disabled';
  name: string;
  /** 覆写：true = 组织级读被 403 ORG_DISABLED（禁用态） */
  detailDisabled?: boolean;
  /** 覆写：true = 成员/邀请读被 403 FORBIDDEN（viewer） */
  restrictedRead?: boolean;
  members: Array<{ userId: string; role: Role; name: string; email: string }>;
}

function makeState(over: Partial<State> = {}): State {
  return {
    role: 'owner', platformAdmin: false, isPersonal: false, status: 'active', name: '团队 A',
    members: [
      { userId: 'u-1', role: 'owner', name: '我', email: 'me@example.com' },
      { userId: 'u-2', role: 'member', name: 'Bob', email: 'bob@example.com' },
    ],
    ...over,
  };
}

function mockApi(state: State) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const forbidden = jsonResponse({ error: { code: 'FORBIDDEN', message: '权限不足' } }, 403);

    if (url === '/api/v1/auth/me') return jsonResponse(state.platformAdmin ? ME_ADMIN : ME);
    if (url === '/api/v1/organizations' && method === 'GET') {
      return jsonResponse({ data: [{ id: ORG_ID, name: state.name, members: [{ role: state.role }] }] });
    }
    if (url === `/api/v1/organizations/${ORG_ID}` && method === 'GET') {
      if (state.detailDisabled) {
        return jsonResponse({ error: { code: 'ORG_DISABLED', message: '组织已被禁用，无法读取' } }, 403);
      }
      return jsonResponse({
        data: {
          id: ORG_ID, name: state.name, slug: 'team-a', isPersonal: state.isPersonal, ownerUserId: 'u-1',
          status: state.status, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z',
          members: state.members.map((m) => ({ userId: m.userId, role: m.role, joinedAt: '2026-09-01T00:00:00.000Z' })),
        },
      });
    }
    if (url === `/api/v1/organizations/${ORG_ID}` && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { name?: string };
      if (body.name) state.name = body.name;
      return jsonResponse({ data: { id: ORG_ID, name: state.name, slug: 'team-a', isPersonal: state.isPersonal, ownerUserId: 'u-1', status: state.status, createdAt: 'T', updatedAt: 'T' } });
    }
    if (url === `/api/v1/organizations/${ORG_ID}` && method === 'DELETE') {
      return jsonResponse({ data: { deleted: true } });
    }
    if (url === `/api/v1/organizations/${ORG_ID}/disable` && method === 'POST') {
      state.status = 'disabled'; state.detailDisabled = true;
      return jsonResponse({ data: { id: ORG_ID, status: 'disabled', unchanged: false } }, 201);
    }
    if (url === `/api/v1/organizations/${ORG_ID}/enable` && method === 'POST') {
      state.status = 'active'; state.detailDisabled = false;
      return jsonResponse({ data: { id: ORG_ID, status: 'active', unchanged: false } }, 201);
    }
    if (url === `/api/v1/organizations/${ORG_ID}/members` && method === 'GET') {
      if (state.restrictedRead) return forbidden;
      return jsonResponse({
        data: state.members.map((m, i) => ({
          id: `m-${i}`, organizationId: ORG_ID, userId: m.userId, role: m.role,
          joinedAt: '2026-09-01T00:00:00.000Z', createdAt: 'T', updatedAt: 'T',
          user: { id: m.userId, email: m.email, displayName: m.name },
        })),
      });
    }
    if (url === `/api/v1/organizations/${ORG_ID}/members/u-2` && method === 'DELETE') {
      state.members = state.members.filter((m) => m.userId !== 'u-2');
      return jsonResponse({ data: { removed: true } });
    }
    if (url === `/api/v1/organizations/${ORG_ID}/invitations` && method === 'GET') {
      if (state.restrictedRead) return forbidden;
      return jsonResponse({
        data: [
          { id: 'inv-1', organizationId: ORG_ID, email: 'new@example.com', role: 'member', invitedByUserId: 'u-1', token: PENDING_TOKEN, status: 'pending', expiresAt: '2026-10-06T00:00:00.000Z', acceptedByUserId: null, createdAt: '2026-09-29T00:00:00.000Z' },
          { id: 'inv-2', organizationId: ORG_ID, email: 'done@example.com', role: 'viewer', invitedByUserId: 'u-1', token: ACCEPTED_TOKEN, status: 'accepted', expiresAt: '2026-10-01T00:00:00.000Z', acceptedByUserId: 'u-5', createdAt: '2026-09-20T00:00:00.000Z' },
        ],
      });
    }
    if (url === `/api/v1/organizations/${ORG_ID}/invitations` && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { email: string; role?: Role };
      return jsonResponse({
        data: { invitationId: 'inv-9', token: 'c'.repeat(48), email: body.email, role: body.role ?? 'member', expiresAt: '2026-10-06T00:00:00.000Z' },
      }, 201);
    }
    if (url === `/api/v1/invitations/${PENDING_TOKEN}/revoke` && method === 'POST') {
      return jsonResponse({ data: { revoked: true } }, 201);
    }
    throw new Error(`未预期的请求：${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderDetail(state: State = makeState()) {
  const fetchMock = mockApi(state);
  const title = state.name;
  await act(async () => {
    renderWithQuery(
      <Suspense fallback={<p>页面加载中…</p>}>
        <OrganizationDetailPage params={Promise.resolve({ id: ORG_ID })} />
      </Suspense>,
    );
  });
  await screen.findByRole('heading', { name: title }); // 标题来自组织列表（详情被冻结时也拿得到）
  if (!state.detailDisabled && !state.restrictedRead) {
    // 成员/邀请是详情成功后的级联查询 → 等它们落地再断言，避免与加载骨架竞争
    await screen.findByText('bob@example.com');
    await screen.findByText('new@example.com');
  }
  return fetchMock;
}

const dialog = () => screen.findByRole('dialog');

describe('/organizations/[id] owner：信息 / 治理态 / 成员 / 邀请', () => {
  it('头部与组织信息按服务端返回呈现（角色徽标来自服务端）', async () => {
    await renderDetail();
    expect(screen.getByRole('heading', { name: '团队 A' })).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('我的角色 owner')).toBeInTheDocument();
    expect(screen.getByText('team-a')).toBeInTheDocument();
    expect(screen.getByText('u-1')).toBeInTheDocument(); // ownerUserId
    expect(screen.getByText('成员数（详情投影）').parentElement).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: '保存名称' })).toBeDisabled(); // 未改动
  });

  it('成员表：owner 行不可移除（须保留 owner），非 owner 行可移除且标出「我」', async () => {
    await renderDetail();
    const ownerRow = screen.getByText('me@example.com').closest('tr')!;
    expect(within(ownerRow).getByText('owner')).toBeInTheDocument();
    expect(within(ownerRow).getByText('（我）')).toBeInTheDocument();
    expect(within(ownerRow).getByText('须保留 owner')).toBeInTheDocument();
    expect(within(ownerRow).queryByRole('button', { name: '移除' })).toBeNull();

    const memberRow = screen.getByText('bob@example.com').closest('tr')!;
    expect(within(memberRow).getByRole('button', { name: '移除' })).toBeInTheDocument();
  });

  it('更新名称：PATCH body {name} → 提示 + 失效重取（新名字回到页面）', async () => {
    const fetchMock = await renderDetail();
    fireEvent.change(screen.getByLabelText('组织名称'), { target: { value: '团队 A2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === `/api/v1/organizations/${ORG_ID}` && i?.method === 'PATCH');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ name: '团队 A2' });
    });
    expect(await screen.findByRole('status')).toHaveTextContent('组织名称已更新：团队 A2');
    await waitFor(() => expect(screen.getByRole('heading', { name: '团队 A2' })).toBeInTheDocument());
  });

  it('移除成员：确认框带被移除者标识 → DELETE /members/:userId → 提示 + 成员表重取', async () => {
    const fetchMock = await renderDetail();
    fireEvent.click(within(screen.getByText('bob@example.com').closest('tr')!).getByRole('button', { name: '移除' }));

    const d = await dialog();
    expect(within(d).getByRole('heading', { name: '移除成员' })).toBeInTheDocument();
    expect(within(d).getByText(/将 bob@example\.com 移出「团队 A」/)).toBeInTheDocument();
    fireEvent.click(within(d).getByRole('button', { name: '确认移除' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u) === `/api/v1/organizations/${ORG_ID}/members/u-2` && i?.method === 'DELETE')).toBe(true));
    expect(await screen.findByRole('status')).toHaveTextContent('成员已移除');
    await waitFor(() => expect(screen.queryByText('bob@example.com')).toBeNull());
  });

  it('禁用组织：危险操作确认 → POST disable → 提示 + 详情重取后只剩「启用组织」入口', async () => {
    const fetchMock = await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: '禁用组织' }));

    const d = await dialog();
    expect(within(d).getByRole('heading', { name: '禁用组织' })).toBeInTheDocument();
    expect(within(d).getByText(/对被禁用方返回 403 ORG_DISABLED/)).toBeInTheDocument();
    fireEvent.click(within(d).getByRole('button', { name: '确认禁用' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u) === `/api/v1/organizations/${ORG_ID}/disable` && i?.method === 'POST')).toBe(true));
    expect(await screen.findByRole('status')).toHaveTextContent('组织已禁用（组织级端点对该组织成员一律 403）');
    expect(await screen.findByRole('button', { name: '启用组织' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '禁用组织' })).toBeNull();
  });

  it('删除组织（团队）：软删确认 → DELETE /organizations/:id → 提示明确「软删」', async () => {
    const fetchMock = await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: '删除组织' }));

    const d = await dialog();
    expect(within(d).getByRole('heading', { name: '删除组织' })).toBeInTheDocument();
    expect(within(d).getByText(/软删：记录与成员关系保留/)).toBeInTheDocument();
    fireEvent.click(within(d).getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u) === `/api/v1/organizations/${ORG_ID}` && i?.method === 'DELETE')).toBe(true));
    expect(await screen.findByRole('status')).toHaveTextContent('组织已删除（软删：记录保留，不可再访问）');
  });

  it('创建邀请：email 小写化后 POST {email, role} → 一次性 token 明示在页面上', async () => {
    const fetchMock = await renderDetail();
    fireEvent.change(screen.getByLabelText('被邀请人邮箱'), { target: { value: 'New.User@Example.COM' } });
    fireEvent.change(screen.getByLabelText('邀请角色'), { target: { value: 'viewer' } });
    fireEvent.click(screen.getByRole('button', { name: '创建邀请' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === `/api/v1/organizations/${ORG_ID}/invitations` && i?.method === 'POST');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ email: 'new.user@example.com', role: 'viewer' });
    });
    expect(await screen.findByRole('status')).toHaveTextContent('邀请已创建：new.user@example.com（角色 viewer）');
    expect(screen.getByText('c'.repeat(48))).toBeInTheDocument(); // 一次性 token：服务端返回、仅由邀请方转交
  });

  it('邀请表：pending 展示 token 可撤销，已处理行不再展示 token', async () => {
    const fetchMock = await renderDetail();
    const pendingRow = screen.getByText('new@example.com').closest('tr')!;
    expect(within(pendingRow).getByText(PENDING_TOKEN)).toBeInTheDocument();
    expect(within(pendingRow).getByText('pending')).toBeInTheDocument();

    const acceptedRow = screen.getByText('done@example.com').closest('tr')!;
    expect(within(acceptedRow).getByText('已处理')).toBeInTheDocument();
    expect(within(acceptedRow).queryByText(ACCEPTED_TOKEN)).toBeNull();

    fireEvent.click(within(pendingRow).getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u) === `/api/v1/invitations/${PENDING_TOKEN}/revoke` && i?.method === 'POST')).toBe(true));
    expect(await screen.findByRole('status')).toHaveTextContent('邀请已撤销');
  });
});

describe('/organizations/[id] 个人空间与平台管理员', () => {
  it('个人空间：不可删除、owner 不可自助禁用（后端硬规则照实呈现）', async () => {
    await renderDetail(makeState({ isPersonal: true }));
    expect(screen.getByText('个人空间')).toBeInTheDocument();
    expect(screen.getByText('个人空间不可删除（服务端硬规则：账号默认工作区）')).toBeInTheDocument();
    expect(screen.getByText('个人空间不可由 owner 自助禁用（平台管理员可执行平台级禁用）')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除组织' })).toBeNull();
    expect(screen.queryByRole('button', { name: '禁用组织' })).toBeNull();
  });

  it('平台管理员：可对个人空间执行平台级禁用（入口来自 /auth/me 的 role）', async () => {
    await renderDetail(makeState({ isPersonal: true, platformAdmin: true }));
    expect(screen.getByText('平台管理员')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '禁用组织' })).toBeInTheDocument();
    expect(screen.queryByText(/个人空间不可由 owner 自助禁用/)).toBeNull();
  });
});

describe('/organizations/[id] RBAC 如实呈现（前端只显隐，裁决在服务端）', () => {
  it('viewer：成员/邀请读被 403 → 无权限徽标 + 原始 message；写入口一个都不渲染', async () => {
    await renderDetail(makeState({ role: 'viewer', restrictedRead: true }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('成员加载失败：权限不足（FORBIDDEN）');
    expect(alerts[1]).toHaveTextContent('邀请加载失败：权限不足（FORBIDDEN）');
    expect(screen.getAllByText('无权限').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText('仅组织 owner 可更新组织信息（服务端 organization.write）')).toBeInTheDocument();
    expect(screen.getByText('仅组织 owner 或平台管理员可变更加治理态')).toBeInTheDocument();
    expect(screen.getByText('仅 owner/admin 可创建或撤销邀请')).toBeInTheDocument();

    for (const name of ['保存名称', '禁用组织', '删除组织', '移除', '创建邀请', '撤销']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.getByText('我的角色 viewer')).toBeInTheDocument(); // 角色来自服务端、原样展示
  });

  it('member：成员/邀请可读但不可写（移除与创建入口替换为无权限）', async () => {
    await renderDetail(makeState({ role: 'member' }));
    expect(await screen.findByText('bob@example.com')).toBeInTheDocument(); // 读得到（member.read 含 member）
    const memberRow = screen.getByText('bob@example.com').closest('tr')!;
    expect(within(memberRow).queryByRole('button', { name: '移除' })).toBeNull();
    expect(within(memberRow).getByText('无权限')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '创建邀请' })).toBeNull();
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull();
  });

  it('组织被禁用（403 ORG_DISABLED）：详情不可读 → 只剩「启用组织」，确认后恢复', async () => {
    const fetchMock = await renderDetail(makeState({ status: 'disabled', detailDisabled: true }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('组织已被禁用，无法读取（ORG_DISABLED）');
    expect(within(alert).getByText('组织已禁用')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存名称' })).toBeNull(); // 冻结态下不渲染管理面

    fireEvent.click(screen.getByRole('button', { name: '启用组织' }));
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: '启用组织' })).toBeInTheDocument();
    fireEvent.click(within(d).getByRole('button', { name: '确认启用' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u) === `/api/v1/organizations/${ORG_ID}/enable` && i?.method === 'POST')).toBe(true));
    expect(await screen.findByRole('status')).toHaveTextContent('组织已启用');
    expect(await screen.findByText('组织信息')).toBeInTheDocument();
  });
});
