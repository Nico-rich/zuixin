import { adminCredentials } from './support/stack';
import { expect, test } from './support/fixtures';

/**
 * 覆盖点 1：登录页真实登录流（表单 → 跳转 → cookie 会话可用）。
 * 覆盖点 8：Cookie 属性在**真实浏览器**侧生效（Set-Cookie 属性 + cookie jar + HttpOnly 不可见）。
 * 对应 M8 审计缺口：会话/Cookie 语义此前仅服务端断言。
 */
test.describe('登录页真实登录流与 Cookie 属性（真实浏览器）', () => {
  test('表单登录 → 跳转 /chat → 会话可用；Set-Cookie 属性与 HttpOnly 在浏览器生效', async ({ page, context }) => {
    const { email, password } = adminCredentials();
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'AI Agent 智能创作平台' })).toBeVisible();

    const loginResponse = page.waitForResponse((r) => r.url().includes('/api/v1/auth/login') && r.request().method() === 'POST');
    await page.getByPlaceholder('邮箱').fill(email);
    await page.getByPlaceholder('密码').fill(password);
    await page.getByRole('button', { name: '登录' }).click();

    const res = await loginResponse;
    expect(res.status()).toBe(201);
    // 同源：登录请求经 web 源（Next rewrites 代理），浏览器从不直连 api 源
    expect(res.url().startsWith('http://localhost:')).toBe(true);
    expect(new URL(res.url()).pathname).toBe('/api/v1/auth/login');

    // 服务端下发的属性（真实响应头，非单测断言）
    // 注：Playwright 的 headers() 不返回 set-cookie（多值头会丢），必须用 headersArray()
    const setCookie = (await res.headersArray())
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value)
      .join('\n');
    expect(setCookie).toContain('agent_access=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/api/v1/auth'); // refresh cookie 的收窄路径

    // 跳转与受保护页面可用
    await expect(page).toHaveURL(/\/chat$/, { timeout: 45_000 });
    await expect(page.locator('textarea')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('加载中…')).toHaveCount(0);

    // 浏览器 cookie jar 落地属性（access 全站可用；refresh 仅 /api/v1/auth）
    const cookies = await context.cookies();
    const access = cookies.find((c) => c.name === 'agent_access');
    const refresh = cookies.find((c) => c.name === 'agent_refresh');
    expect(access, 'agent_access 应已写入浏览器 cookie jar').toBeTruthy();
    expect(access!.httpOnly).toBe(true);
    expect(access!.path).toBe('/');
    expect(access!.sameSite).toBe('Lax');
    expect(refresh, 'agent_refresh 应已写入浏览器 cookie jar').toBeTruthy();
    expect(refresh!.httpOnly).toBe(true);
    expect(refresh!.path).toBe('/api/v1/auth');
    // dev/CI 明文 HTTP 环境不带 Secure（生产 NODE_ENV=production / COOKIE_SECURE=true 才加，见 auth.controller）
    expect(access!.secure).toBe(false);

    // HttpOnly 在浏览器侧真实生效：脚本读不到会话 cookie
    const docCookie = await page.evaluate(() => document.cookie);
    expect(docCookie).not.toContain('agent_access');
    expect(docCookie).not.toContain('agent_refresh');

    // 会话是 cookie 驱动的（刷新后仍可用，非内存态）
    await page.reload();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 45_000 });
  });

  test('凭据错误：回显后端错误、不写会话 cookie、停留登录页', async ({ page, context }) => {
    const { email } = adminCredentials();
    await page.goto('/login');
    await page.getByPlaceholder('邮箱').fill(email);
    await page.getByPlaceholder('密码').fill('definitely-wrong-password');
    await page.getByRole('button', { name: '登录' }).click();

    const error = page.locator('p.text-red-400');
    await expect(error).toBeVisible({ timeout: 30_000 });
    expect((await error.innerText()).trim().length).toBeGreaterThan(0);
    expect(page.url()).toContain('/login');
    expect((await context.cookies()).map((c) => c.name)).not.toContain('agent_access');
  });

  test('未登录访问受保护页 /chat → 重定向 /login（cookie 是唯一凭据）', async ({ page }) => {
    await page.goto('/chat');
    await expect(page).toHaveURL(/\/login$/, { timeout: 45_000 });
  });
});
