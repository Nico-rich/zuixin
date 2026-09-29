import { MOCK_DELAY_MS } from './support/stack';
import { assistantBubbles, expect, lastAssistantText, openChat, sendChat, test, uniqueTag, waitForChatSettled } from './support/fixtures';

const strip = (s: string) => s.replace(/\s+/g, '');

/**
 * 覆盖点 2：chat 页 SSE 真流式——发消息 → token 级增量渲染 → 完成（streaming 状态流转）。
 *
 * 断言口径（不是“最终文本对不对”，而是“渲染是否真的逐 token 推进”）：
 * 采样气泡文本，要求出现 ≥3 个互不相同的中间态、且都是最终文本的前缀
 * （追加式 token 流，而非一次性整体替换/重渲染）。
 */
test.describe('chat SSE 真流式（真实浏览器 + 真实 api/web 进程）', () => {
  test('发消息 → token 级增量渲染 → 完成态收束（streaming 状态流转）', async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    await openChat(page);
    const tag = uniqueTag('stream');
    const message = `你好，${tag}，请用三句话介绍你自己`;

    await sendChat(page, message);

    // streaming=true 的可见证据：输入区切换为“停止生成”
    await expect(page.getByTitle('停止生成')).toBeVisible({ timeout: 60_000 });
    // message_start 后 URL 收敛到真实会话（临时态 → 落库会话）
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 60_000 });

    const samples: string[] = [];
    let sawCursor = false;
    let sawThinking = false;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const text = strip(await lastAssistantText(page));
      if (text && text !== samples[samples.length - 1]) samples.push(text);
      if ((await page.locator('div.group span.animate-pulse').count()) > 0) sawCursor = true;
      if ((await page.locator('p', { hasText: '💭' }).count()) > 0) sawThinking = true;
      if (await page.getByTitle('发送').isVisible()) break;
      await page.waitForTimeout(60);
    }

    await waitForChatSettled(page);
    const final = samples[samples.length - 1] ?? '';
    const completed = strip(await lastAssistantText(page));
    expect(completed).toContain('mock模型回复'); // mock 实际回显文本（无空格——与 mock 适配器文案对齐）
    expect(completed).toContain(tag); // mock 回显用户消息 → 确认是本次消息的回复

    // token 级增量（MOCK_DELAY_MS 保证中间态可观测）
    expect(samples.length, '应观测到多个不同的中间渲染态（当前 MOCK_DELAY_MS=' + MOCK_DELAY_MS + '）').toBeGreaterThanOrEqual(3);
    expect(final.length).toBeGreaterThan(0);
    const intermediate = samples.slice(0, -1);
    expect(intermediate.every((s) => completed.startsWith(s)), '中间态必须是最终文本的前缀（追加式流式，非整体替换）').toBe(true);
    expect(intermediate.filter((s) => s.length < completed.length).length).toBeGreaterThanOrEqual(2);
    expect(sawCursor, '流式期间应出现光标 ▍').toBe(true);
    expect(sawThinking, '流式期间应出现思考态提示 💭').toBe(true);

    // 完成态：光标消失、停止按钮回归发送、无错误
    await expect(page.locator('div.group span.animate-pulse')).toHaveCount(0);
    await expect(page.locator('p', { hasText: '💭' })).toHaveCount(0);
    await expect(page.locator('p.text-red-400')).toHaveCount(0);

    // 落库可回放：刷新后这条回复仍在（终态持久化，不是只在内存里）
    await page.reload();
    await expect(page.getByText(tag, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
    await expect(assistantBubbles(page).last()).toContainText('本地 mock 模型回复');
  });
});
