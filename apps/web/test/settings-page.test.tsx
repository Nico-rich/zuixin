import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from '@/app/settings/page';
import { ToastProvider } from '@/components/ui/toast';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * /settings 页面（M13-W9）：账号信息（useCurrentUser）+ 会话/设备管理。
 *  - 会话表：设备 / 来源 IP / 时间 / 当前会话标记；
 *  - 四个动作分别打到真实端点：下线单会话、按设备下线、全部下线、轮换当前令牌；
 *  - 破坏性动作（下线当前会话 / 全部下线）先经 Dialog 明示后果，成功后跳登录页。
 */

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings',
}));

const ME = { data: { user: { id: 'u1', email: 'admin@example.com', displayName: '管理员', role: 'owner' } } };

const CURRENT = {
  id: 's-current', deviceId: 'dev-1', userAgent: 'MacBook · Chrome', ip: '10.0.0.1',
  createdAt: '2026-09-29T00:00:00.000Z', expiresAt: '2026-09-30T00:00:00.000Z', current: true,
};
const OTHER = {
  id: 's-other', deviceId: 'dev-2', userAgent: 'iPhone · Safari', ip: '10.0.0.2',
  createdAt: '2026-09-28T00:00:00.000Z', expiresAt: '2026-09-30T00:00:00.000Z', current: false,
};

function mockApi(sessions: unknown[] = [CURRENT, OTHER]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/api/v1/auth/me')) return jsonResponse(ME);
    if (url.includes('/api/v1/auth/sessions/device/')) return jsonResponse({ data: { ok: true, revokedSessions: 1 } });
    if (url.includes('/api/v1/auth/sessions/') && method === 'DELETE') return jsonResponse({ data: { ok: true, revokedSessions: 1 } });
    if (url.includes('/api/v1/auth/sessions')) return jsonResponse({ data: { sessions } });
    if (url.includes('/api/v1/auth/logout-all')) return jsonResponse({ data: { ok: true, revokedSessions: 2, blacklistedJtis: 2 } });
    if (url.includes('/api/v1/auth/rotate')) return jsonResponse({ data: { user: ME.data.user } });
    throw new Error(`未预期的请求：${url} ${method}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const rendered = () => renderWithQuery(<ToastProvider><SettingsPage /></ToastProvider>);

describe('/settings 设置页（M13-W9）', () => {
  beforeEach(() => replaceMock.mockClear());

  it('账号信息 + 会话表（设备/来源 IP/时间/当前会话标记）', async () => {
    mockApi();
    rendered();

    expect(await screen.findByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('管理员')).toBeInTheDocument();
    expect(await screen.findByText('MacBook · Chrome')).toBeInTheDocument();
    expect(screen.getByText('iPhone · Safari')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument();
    expect(screen.getByText('当前会话')).toBeInTheDocument(); // 服务端判定的 current 标记
  });

  it('下线他人会话：Dialog 确认后 DELETE /auth/sessions/:id，且不跳登录页', async () => {
    const fetchMock = mockApi();
    rendered();

    fireEvent.click(await screen.findByRole('button', { name: '下线会话：iPhone · Safari' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('确认下线该会话？')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认下线' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => (c[1]?.method ?? 'GET') === 'DELETE');
      expect(String(call![0])).toContain('/api/v1/auth/sessions/s-other');
    });
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('下线**当前**会话：DELETE 后跳登录页（本机凭据失效）', async () => {
    const fetchMock = mockApi();
    rendered();

    fireEvent.click(await screen.findByRole('button', { name: '下线会话：MacBook · Chrome' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认下线' }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
    expect(String(fetchMock.mock.calls.find((c) => (c[1]?.method ?? 'GET') === 'DELETE')![0]))
      .toContain('/api/v1/auth/sessions/s-current');
  });

  it('按设备下线：DELETE /auth/sessions/device/:deviceId（设备维度失效）', async () => {
    const fetchMock = mockApi();
    rendered();

    fireEvent.click(await screen.findByRole('button', { name: '下线设备全部会话：iPhone · Safari' }));
    expect(within(await screen.findByRole('dialog')).getByText('确认下线该设备的全部会话？')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认下线' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/auth/sessions/device/'));
      expect(String(call![0])).toContain('/api/v1/auth/sessions/device/dev-2');
    });
  });

  it('全部下线：Dialog 明示"含本机"后果 → POST /auth/logout-all + 跳登录页', async () => {
    const fetchMock = mockApi();
    rendered();

    fireEvent.click(await screen.findByRole('button', { name: /全部下线/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('确认下线全部会话？')).toBeInTheDocument();
    expect(within(dialog).getByText(/包括本机在内的所有已登录会话都会立即失效/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '确认下线' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => String(c[0]).includes('/auth/logout-all'));
      expect(post).toBeTruthy();
      expect((post![1]?.method ?? 'GET').toUpperCase()).toBe('POST');
    });
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
  });

  it('轮换当前会话令牌：POST /auth/rotate（不清会话、不跳转）', async () => {
    const fetchMock = mockApi();
    rendered();

    fireEvent.click(await screen.findByRole('button', { name: /轮换当前令牌/ }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => String(c[0]).includes('/auth/rotate'));
      expect(post).toBeTruthy();
      expect((post![1]?.method ?? 'GET').toUpperCase()).toBe('POST');
    });
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('无会话 → 空态行（不伪造会话）', async () => {
    mockApi([]);
    rendered();
    expect(await screen.findByText('当前没有已登录会话')).toBeInTheDocument();
  });
});
