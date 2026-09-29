import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ConnectionsPage from '@/app/connections/page';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * /connections（M13-W5）：连接列表 + 发起/刷新/吊销/删除。
 *
 * 本文件最重要的一条是**凭证红线**（路线图 §4）：页面渲染永不出现 access token / refresh token /
 * 任何凭证字段。测试在服务端响应里**故意注入** accessToken / refreshToken / credentials / metadata，
 * 断言它们一个字节都不进 DOM —— 这条断言比「类型里没有该字段」更强：它同时挡住
 * 「页面把整个对象 JSON.stringify / 展开渲染」这类未来的回归。
 */

const { redirectMock } = vi.hoisted(() => ({ redirectMock: vi.fn() }));
vi.mock('@/lib/redirect', () => ({ redirectTo: redirectMock }));

const EXPIRES = '2026-10-01T00:00:00.000Z';
const SYNCED = '2026-09-29T01:02:03.000Z';
const CREATED = '2026-09-01T00:00:00.000Z';

/** 后端 CONNECTION_SELECT 的形状 + **故意注入**的凭证字段（页面绝不能渲染它们） */
const CONNECTION = {
  id: 'conn-1', userId: 'u-1', projectId: null, provider: 'mock',
  providerAccountId: 'acct-9', status: 'active', scope: ['read', 'write'],
  expiresAt: EXPIRES, revokedAt: null, lastSyncedAt: SYNCED, createdAt: CREATED, updatedAt: SYNCED,
  accessToken: 'SECRET-ACCESS-TOKEN',
  refreshToken: 'SECRET-REFRESH-TOKEN',
  credentials: { encryptedValue: 'SECRET-ENCRYPTED-VALUE' },
  metadata: { accessToken: 'SECRET-IN-METADATA' },
};

const SECRETS = ['SECRET-ACCESS-TOKEN', 'SECRET-REFRESH-TOKEN', 'SECRET-ENCRYPTED-VALUE', 'SECRET-IN-METADATA'];

interface MockState { connections: Array<Record<string, unknown>>; refreshStatus?: number }

function mockApi(state: MockState) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url === '/api/v1/connections' && method === 'GET') return jsonResponse({ data: state.connections });
    if (url === '/api/v1/connections/mock/start' && method === 'POST') {
      return jsonResponse({ data: { authorizeUrl: 'https://mock-oauth.local/authorize?provider=mock&state=st-1', state: 'st-1' } }, 201);
    }
    if (url === '/api/v1/connections/conn-1/refresh' && method === 'POST') {
      if (state.refreshStatus === 409) {
        return jsonResponse({ error: { code: 'CONNECTION_REVOKED', message: '连接已吊销，请重新连接' } }, 409);
      }
      state.connections = state.connections.map((c) => (c.id === 'conn-1' ? { ...c, status: 'active', lastSyncedAt: '2026-09-30T00:00:00.000Z' } : c));
      return jsonResponse({ data: { ...CONNECTION, status: 'active' } }, 201);
    }
    if (url === '/api/v1/connections/conn-1/revoke' && method === 'POST') {
      state.connections = state.connections.map((c) => (c.id === 'conn-1' ? { ...c, status: 'revoked', revokedAt: SYNCED } : c));
      return jsonResponse({ data: { ...CONNECTION, status: 'revoked' } }, 201);
    }
    if (url === '/api/v1/connections/conn-1' && method === 'DELETE') {
      state.connections = state.connections.filter((c) => c.id !== 'conn-1');
      return jsonResponse({ data: { deleted: true } });
    }
    throw new Error(`未预期的请求：${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage(state: MockState = { connections: [CONNECTION] }) {
  const fetchMock = mockApi(state);
  const view = renderWithQuery(<ConnectionsPage />);
  await screen.findByRole('cell', { name: /mock/ }); // 列表行出现 = 首帧数据已到
  return { fetchMock, view };
}

beforeEach(() => { redirectMock.mockClear(); });

describe('/connections 列表与凭证红线', () => {
  it('呈现 provider / 状态 / 过期时间 / 同步时间，且**响应里的凭证字段一个都不进 DOM**', async () => {
    const { view } = await renderPage();
    const row = screen.getByRole('cell', { name: /mock/ }).closest('tr')!;

    expect(within(row).getByText('mock')).toBeInTheDocument();
    expect(within(row).getByText('acct-9')).toBeInTheDocument();
    expect(within(row).getByText('active')).toBeInTheDocument();
    expect(within(row).getByText(new Date(EXPIRES).toLocaleString())).toBeInTheDocument();
    expect(within(row).getByText(new Date(SYNCED).toLocaleString())).toBeInTheDocument();
    expect(within(row).getByText('2 项')).toBeInTheDocument(); // scope 只报条目数，不回显内容

    // 凭证红线：DOM 里不得出现任何凭证值，也不得出现凭证字段名（页面从不展开/序列化连接对象）
    const html = view.container.innerHTML;
    for (const secret of SECRETS) expect(html, `凭证泄漏：${secret}`).not.toContain(secret);
    expect(html).not.toContain('accessToken');
    expect(html).not.toContain('refreshToken');
    expect(html).not.toContain('encryptedValue');
  });

  it('空态：明确提示而不是空表', async () => {
    mockApi({ connections: [] });
    renderWithQuery(<ConnectionsPage />);
    expect(await screen.findByText('暂无连接 · 用上方「发起连接」开始授权')).toBeInTheDocument();
  });

  it('列表加载失败：原样展示服务端 code + message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'INTERNAL', message: '数据库不可用' } }, 500)));
    renderWithQuery(<ConnectionsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('连接列表加载失败：数据库不可用（INTERNAL）');
  });
});

describe('/connections 发起连接（start → authorizeUrl）', () => {
  it('POST /connections/:provider/start 后用服务端下发的 authorizeUrl 跳转（前端不拼 URL、不碰授权码）', async () => {
    const { fetchMock } = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '发起连接' }));

    await waitFor(() => expect(redirectMock).toHaveBeenCalledWith('https://mock-oauth.local/authorize?provider=mock&state=st-1'));
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/start'))!;
    expect(String(call[0])).toBe('/api/v1/connections/mock/start');
    expect(call[1]?.method).toBe('POST');
    expect(await screen.findByRole('status')).toHaveTextContent('已发起 mock 授权，正在跳转到授权页…');
  });

  it('provider 未注册（404 PROVIDER_UNSUPPORTED）：如实报错且不跳转', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.includes('/start')) {
        return jsonResponse({ error: { code: 'PROVIDER_UNSUPPORTED', message: '不支持的 Provider' } }, 404);
      }
      return jsonResponse({ data: [] });
    }));
    renderWithQuery(<ConnectionsPage />);
    await screen.findByText('暂无连接 · 用上方「发起连接」开始授权');

    fireEvent.change(screen.getByLabelText('服务商'), { target: { value: 'github' } });
    fireEvent.click(screen.getByRole('button', { name: '发起连接' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('不支持的 Provider（PROVIDER_UNSUPPORTED）');
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe('/connections 刷新 / 吊销 / 删除', () => {
  it('刷新：POST refresh 后失效缓存重取列表（服务端状态为准）', async () => {
    const { fetchMock } = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u) === '/api/v1/connections/conn-1/refresh' && i?.method === 'POST')).toBe(true));
    expect(await screen.findByRole('status')).toHaveTextContent('连接 mock 已刷新（状态 active）');
    // 失效后重新拉列表（GET 次数 >= 2）
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u, i]) => String(u) === '/api/v1/connections' && (i?.method ?? 'GET') === 'GET').length).toBeGreaterThanOrEqual(2));
  });

  it('刷新失败（409 CONNECTION_REVOKED）：原样呈现服务端 message，不伪造成功', async () => {
    await renderPage({ connections: [CONNECTION], refreshStatus: 409 });
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('连接已吊销，请重新连接（CONNECTION_REVOKED）');
  });

  it('吊销：确认 Dialog → POST revoke → 行状态变为 revoked，且已吊销行不再提供刷新/吊销', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '吊销' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '吊销连接' })).toBeInTheDocument();
    expect(within(dialog).getByText(/需要重新授权才能继续使用/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认吊销' }));

    await waitFor(() => expect(screen.getByRole('cell', { name: /mock/ }).closest('tr')).toHaveTextContent('revoked'));
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '吊销' })).toBeDisabled();
  });

  it('吊销取消：不产生任何写请求', async () => {
    const { fetchMock } = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '吊销' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchMock.mock.calls.some(([, i]) => (i?.method ?? 'GET') !== 'GET')).toBe(false);
  });

  it('删除：确认 Dialog → DELETE → 该行消失并收敛到空态', async () => {
    const { fetchMock } = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '删除连接' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u) === '/api/v1/connections/conn-1' && i?.method === 'DELETE')).toBe(true));
    expect(await screen.findByText('暂无连接 · 用上方「发起连接」开始授权')).toBeInTheDocument();
  });
});
