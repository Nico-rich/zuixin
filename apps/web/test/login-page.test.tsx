import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from '@/app/login/page';
import { RETURN_TO_COOKIE } from '@/lib/route-guard';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * 登录页（M13-F1 两处反模式修复的回归）
 *
 * ① **渲染期 router.replace**：原实现在组件体里直接 `if (me.data) router.replace('/chat')`。
 *    这个测试的判定方式是「后续交互导致的 re-render 不得再次导航」——渲染期副作用会在每次
 *    re-render 重放（输入一个字就多跳一次），而 useEffect 版本只跳一次。
 * ② **被守卫拦下后回不到原页面**：returnTo 提示 cookie → 静默续期 → 直接回到目标页；
 *    续期失败则落回表单（不弹错误，这是正常过期路径）。returnTo 值必须过 sanitizeReturnTo。
 */
const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/login',
}));

const ME = { data: { user: { id: 'u1', email: 'admin@example.com', displayName: '管理员', role: 'owner' } } };

/** 已登录态：/auth/me 200，其余（refresh 等）按参数给 */
function stubLoggedIn() {
  const mock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/v1/auth/me')) return jsonResponse(ME);
    if (url.includes('/api/v1/auth/refresh')) return jsonResponse({ data: { ok: true } });
    return jsonResponse({ data: {} });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** 未登录态：/auth/me 401 */
function stubLoggedOut(refreshOk: boolean) {
  const mock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/v1/auth/me')) return jsonResponse({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, 401);
    if (url.includes('/api/v1/auth/refresh')) {
      return refreshOk
        ? jsonResponse({ data: { ok: true } })
        : jsonResponse({ error: { code: 'UNAUTHORIZED', message: '刷新令牌已过期' } }, 401);
    }
    return jsonResponse({ data: {} });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function setReturnTo(value: string) { document.cookie = `${RETURN_TO_COOKIE}=${value}; Path=/`; }
function readReturnTo(): string | null {
  const hit = document.cookie.split('; ').find((p) => p.startsWith(`${RETURN_TO_COOKIE}=`));
  return hit ? hit.slice(RETURN_TO_COOKIE.length + 1) : null;
}

beforeEach(() => { replaceMock.mockClear(); document.cookie = `${RETURN_TO_COOKIE}=; Path=/; Max-Age=0`; });

describe('渲染期导航反模式', () => {
  it('已有会话 → 跳 /chat，且**不会**在后续 re-render 中重复导航（渲染期副作用的判定特征）', async () => {
    stubLoggedIn();
    renderWithQuery(<LoginPage />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/chat'));
    expect(replaceMock).toHaveBeenCalledTimes(1);

    // 在表单里打字会触发多次 re-render：渲染期调用 router.replace 的旧实现会在这里再次导航
    fireEvent.change(screen.getByPlaceholderText('邮箱'), { target: { value: 'a' } });
    fireEvent.change(screen.getByPlaceholderText('邮箱'), { target: { value: 'ab' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'p' } });
    expect(replaceMock).toHaveBeenCalledTimes(1);
  });

  it('未登录 → 停在表单（不发导航）', async () => {
    stubLoggedOut(true);
    renderWithQuery(<LoginPage />);

    await screen.findByPlaceholderText('邮箱');
    expect(replaceMock).not.toHaveBeenCalled();
  });
});

describe('returnTo：被守卫拦下后的回跳与静默续期', () => {
  it('带 returnTo + refresh 成功 → 直接回到目标页（不要求重新输密码）', async () => {
    stubLoggedOut(true);
    setReturnTo('/workflows/w1');
    renderWithQuery(<LoginPage />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/workflows/w1'));
    expect(screen.queryByPlaceholderText('邮箱')).toBeNull();
  });

  it('returnTo 的查询串被完整保留（回跳不丢参数）；提示 cookie 用完即清', async () => {
    stubLoggedOut(true);
    setReturnTo('/evaluation/runs/r1?tab=score');
    renderWithQuery(<LoginPage />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/evaluation/runs/r1?tab=score'));
    expect(readReturnTo()).toBeNull();
  });

  it('refresh 失败（正常过期）→ 落回登录表单且不弹错误横幅', async () => {
    stubLoggedOut(false);
    setReturnTo('/chat');
    renderWithQuery(<LoginPage />);

    await screen.findByPlaceholderText('邮箱');
    expect(replaceMock).not.toHaveBeenCalled();
    expect(document.querySelector('p.text-red-400')).toBeNull();
    expect(readReturnTo()).toBeNull(); // 失败的 returnTo 也不残留（否则下次访问会再试一遍）
  });

  it('returnTo 是站外地址（开放重定向）→ 一律忽略，按普通登录处理', async () => {
    stubLoggedOut(true);
    setReturnTo('//evil.com');
    renderWithQuery(<LoginPage />);

    await screen.findByPlaceholderText('邮箱');
    // 不做静默续期（值不合法就不该走回跳路径），也不导航
    expect(replaceMock).not.toHaveBeenCalled();
    expect(readReturnTo()).toBeNull();
  });
});

describe('表单提交', () => {
  it('提交成功 → 跳默认目标 /chat', async () => {
    const mock = stubLoggedOut(false);
    renderWithQuery(<LoginPage />);
    await screen.findByPlaceholderText('邮箱');

    fireEvent.change(screen.getByPlaceholderText('邮箱'), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/chat'));
    const loginCall = mock.mock.calls.find((c) => String(c[0]).includes('/api/v1/auth/login'));
    expect(loginCall).toBeDefined();
    expect(JSON.parse(String(loginCall![1]?.body))).toEqual({ email: 'admin@example.com', password: 'secret' });
  });

  it('提交失败 → 呈现服务端错误文案（p.text-red-400 是既有 e2e 的错误态口径）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v1/auth/me')) return jsonResponse({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, 401);
      return jsonResponse({ error: { code: 'UNAUTHORIZED', message: '邮箱或密码不正确' } }, 401);
    }));
    renderWithQuery(<LoginPage />);
    await screen.findByPlaceholderText('邮箱');

    fireEvent.change(screen.getByPlaceholderText('邮箱'), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('邮箱或密码不正确')).toHaveClass('text-red-400');
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
