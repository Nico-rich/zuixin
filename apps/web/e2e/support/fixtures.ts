import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { WEB_ORIGIN, adminCredentials } from './stack';

/** 与 lib/api.ts 同源的 CSRF 自定义头（写请求必须携带） */
export const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * authedPage：真实登录（经 web 源 → Next rewrites → api），cookie 落进浏览器 context 的 cookie jar。
 * 与 UI 表单登录等价（同一端点、同一 CSRF 头、同一 Set-Cookie 链路），仅省一次表单交互。
 */
export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ page, context }, use) => {
    const { email, password } = adminCredentials();
    const res = await context.request.post(`${WEB_ORIGIN}/api/v1/auth/login`, {
      headers: XRW,
      data: { email, password },
    });
    if (!res.ok()) throw new Error(`e2e 登录失败：HTTP ${res.status()} ${await res.text()}`);
    await use(page);
  },
});

export { expect };

/** 唯一标记：断言一律按本套件自造的 id/文案收敛（Pub/Sub 通道全局，禁全局负向断言） */
export function uniqueTag(prefix = 'e2e'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function openChat(page: Page): Promise<void> {
  await page.goto('/chat');
  await expect(page.locator('textarea')).toBeVisible({ timeout: 60_000 });
}

export async function sendChat(page: Page, text: string): Promise<void> {
  const box = page.locator('textarea');
  await box.fill(text);
  await page.getByTitle('发送').click();
}

/** 助手气泡（MessageBubble 的 assistant 分支根节点 class="group"） */
export function assistantBubbles(page: Page): Locator {
  return page.locator('div.group');
}

/** 助手气泡内 Markdown 渲染根的文本（不含流式光标 ▍） */
export async function lastAssistantText(page: Page): Promise<string> {
  const root = assistantBubbles(page).last().locator('div.max-w-none');
  if ((await root.count()) === 0) return '';
  return (await root.innerText()).trim();
}

/** 等待流式收束：发送按钮回归（streaming=false）且错误提示不存在 */
export async function waitForChatSettled(page: Page, timeout = 120_000): Promise<void> {
  await expect(page.getByTitle('发送')).toBeVisible({ timeout });
  await expect(page.locator('p.text-red-400')).toHaveCount(0);
}

/** 时间线行：图标 + 标题 + 摘要同在一行（run-timeline.tsx 的 Row） */
export function timelineRow(page: Page, title: string | RegExp): Locator {
  return page.locator('div.flex.items-start.gap-2.py-1').filter({ hasText: title }).first();
}
