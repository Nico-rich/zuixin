import { Queue } from 'bullmq';
import { REDIS_URL } from './support/stack';
import { expect, openChat, sendChat, test } from './support/fixtures';

/**
 * 覆盖点 4：task-card（生图任务：进度推进 → 完成卡片）。
 *
 * 确定性手法（M11 集成修复）：改用 **BullMQ 队列暂停**而非停 worker 进程——
 * Windows 下 pnpm→cmd→node 进程链在 taskkill /T 后仍有幸存消费者（实抓），
 * “停机窗口”不可靠；`imageQueue.pause()` 让任务**天然停在 pending**（任何残留
 * worker 都抢不走），卡片显示“排队中…”+ 进度条，再 resume 观察真实消费 → 完成态 +
 * 生成图片落回助手消息。全程走真实 api + 真实 BullMQ 队列（REDIS db /33）+ 真实浏览器。
 */
test.describe('任务卡（生图任务，真实 worker 消费）', () => {
  test('排队中（进度条）→ 恢复 worker → ✅ 完成 + 图片附件真实加载', async ({ authedPage: page }) => {
    test.setTimeout(300_000);

    const imageQueue = new Queue('image', { connection: { url: REDIS_URL, maxRetriesPerRequest: null } });
    // 确定性“无消费者”窗口：暂停队列（任务停在 pending；与进程树状态无关）
    await imageQueue.pause();

    try {
      await openChat(page);
      await sendChat(page, '帮我做一张科技感主图');

      // 生图意图 → ImageAgent 直连建任务（无 AgentRun），卡片由 SSE task.created 渲染
      const card = page.locator('div.my-3.rounded-xl').first();
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(card).toContainText('图片生成');
      await expect(card).toContainText('排队中'); // 实际文案无省略号（media-generation statusMessage='排队中'）
      // 非终态才渲染进度条（task-card.tsx）：pending/processing 分支
      await expect(card.locator('div[style*="width"]')).toHaveCount(1);

      // 进度推进：恢复队列 → 被真实 worker 消费 → 卡片转终态
      await imageQueue.resume();
      await expect(card).toContainText('✅ 完成', { timeout: 120_000 });
      await expect(card.locator('div[style*="width"]')).toHaveCount(0); // 终态不再渲染进度条

      // 生成结果：attachment 挂回助手消息，经同源 /api/v1/attachments 代理加载（带 cookie）
      const img = page.locator('div.group img').first();
      await expect(img).toBeVisible({ timeout: 120_000 });
      const naturalWidth = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
      expect(naturalWidth, '图片应真实加载成功（1×1 mock PNG）').toBeGreaterThan(0);
      // 消息刷新后不含错误提示
      await expect(page.locator('p.text-red-400')).toHaveCount(0);
    } finally {
      // 无论成败都恢复队列（后续用例/清理依赖它）
      await imageQueue.resume().catch(() => undefined);
      await imageQueue.close().catch(() => undefined);
      // 自清理：本用例在**共享库**建会话+消息+附件行（文件落在 e2e 临时存储，套件结束即消失）。
      // 不删则产品聊天列表残留"行在字节失"的测试会话（2026-09-29 实抓：曾把生产 API 进程打崩）。
      // 会话级 DELETE 级联消息；附件行无 HTTP 删除面，残留为 messageId=null 行（GET 已 404 兜底）。
      try {
        const cid = page.url().split('/chat/')[1]?.split('?')[0];
        if (cid) {
          await page.request.delete(`/api/v1/conversations/${cid}`, {
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
          });
        }
      } catch {
        // 清理失败不掩盖用例结论（残留无害：GET 已 404 兜底）
      }
    }
  });
});
