import { assistantBubbles, expect, openChat, sendChat, test, uniqueTag, waitForChatSettled } from './support/fixtures';

/**
 * 覆盖点 5：message-bubble / markdown-renderer —— 代码高亮、表格渲染、注入不执行（真实浏览器）。
 *
 * 手法：把 markdown + HTML 注入载荷当**用户消息**发出去（mock 模型会原样回显），
 * 于是同一段文本会同时经过「用户气泡纯文本渲染」与「助手气泡 Markdown 渲染」两条路径。
 * 断言：字形可见（转义成文本）但不产生 DOM 节点、不执行、不弹窗。
 */
const XSS_CODE = '<script>window.__xss_code=1</script>';
const XSS_TABLE = '<img src=x onerror="window.__xss_img=2">';
const XSS_BLOCK = '<script>window.__xss_block=3</script>';

test.describe('message-bubble / markdown（XSS 与代码/表格渲染，真实浏览器）', () => {
  test('代码块高亮 + 表格渲染 + <script>/onerror 注入不执行', async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });

    await openChat(page);
    const tag = uniqueTag('xss');
    const payload = [
      `请原样复述以下内容（${tag}）：`,
      '',
      '```js',
      `const secret = ${JSON.stringify(XSS_CODE)};`,
      '```',
      '',
      '| 风险项 | 说明 |',
      '| --- | --- |',
      `| XSS | ${XSS_TABLE} |`,
      '',
      XSS_BLOCK,
    ].join('\n');

    await sendChat(page, payload);
    await waitForChatSettled(page);

    // 用户气泡：原文可见（React 纯文本转义）——M13-W10 起定位 testid（外层改为 group/user，见 message-bubble DOM 约束注释）
    await expect(page.locator('[data-testid="user-bubble"]').last()).toContainText(XSS_BLOCK);

    const bubble = assistantBubbles(page).last();
    await expect(bubble).toContainText('本地 mock 模型回复');

    // 1) 代码块：语言标签 + 复制按钮 + 代码正文（rehype-highlight 高亮后仍需渲染出源码）
    await expect(bubble.getByText('js', { exact: true })).toBeVisible();
    await expect(bubble.getByRole('button', { name: /复制/ }).first()).toBeVisible(); // 复制按钮有文本+图标两处，取第一个确定断言
    await expect(bubble.locator('pre code, code')).toContainText('const secret');
    await expect(bubble.locator('pre code, code')).toContainText('__xss_code');

    // 2) 表格：真的渲染成 table/th/td（remark-gfm）
    await expect(bubble.locator('table')).toHaveCount(1);
    await expect(bubble.locator('table th').first()).toContainText('风险项');
    await expect(bubble.locator('table td').first()).toContainText('XSS');

    // 3) 注入不执行：无弹窗、无全局标记、无注入 script 节点、无 onerror 的 img
    expect(dialogs, '不应出现任何浏览器弹窗').toEqual([]);
    const globals = await page.evaluate(() => ({
      code: (window as unknown as Record<string, unknown>).__xss_code ?? null,
      img: (window as unknown as Record<string, unknown>).__xss_img ?? null,
      block: (window as unknown as Record<string, unknown>).__xss_block ?? null,
    }));
    expect(globals).toEqual({ code: null, img: null, block: null });
    const injected = await page.evaluate(() => [...document.scripts].filter((s) => (s.textContent ?? '').includes('__xss')).length);
    expect(injected, '注入的 <script> 不得成为 DOM 节点').toBe(0);
    await expect(bubble.locator('img[src="x"]')).toHaveCount(0);

    // 4) 但字形可见：以转义文本形式呈现（说明是“渲染成文本”而不是“被丢弃/被解析”）
    await expect(bubble).toContainText(XSS_BLOCK);
    await expect(bubble).toContainText('onerror');
  });
});
