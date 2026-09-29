import { isAlive, readState, startWorker, stopWorkerAndWait } from './support/stack';
import { expect, openChat, sendChat, test } from './support/fixtures';

/**
 * 覆盖点 4：task-card（生图任务：进度推进 → 完成卡片）。
 *
 * 确定性手法：worker 由 globalSetup 启动，本用例**先停机**拿到确定的“无消费者”窗口
 * （任务停在 pending，卡片显示“排队中…”+ 进度条），再恢复 worker 观察真实消费 → 完成态 +
 * 生成图片落回助手消息。全程走真实 api + 真实 BullMQ 队列（REDIS db /33）+ 真实浏览器。
 */
test.describe('任务卡（生图任务，真实 worker 消费）', () => {
  test('排队中（进度条）→ 恢复 worker → ✅ 完成 + 图片附件真实加载', async ({ authedPage: page }) => {
    test.setTimeout(300_000);

    const stopped = await stopWorkerAndWait();
    expect(stopped, 'worker 应由 globalSetup 启动（否则本用例失去确定性停机窗口）').toBe(true);

    try {
      await openChat(page);
      await sendChat(page, '帮我做一张科技感主图');

      // 生图意图 → ImageAgent 直连建任务（无 AgentRun），卡片由 SSE task.created 渲染
      const card = page.locator('div.my-3.rounded-xl').first();
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(card).toContainText('图片生成');
      await expect(card).toContainText('排队中…');
      // 非终态才渲染进度条（task-card.tsx）：pending/processing 分支
      await expect(card.locator('div[style*="width"]')).toHaveCount(1);

      // 进度推进：恢复消费者 → 队列被真实消费 → 卡片转终态
      startWorker();
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
      // 无论成败都把 worker 恢复（后续用例/清理依赖它）
      const { workerPid } = readState();
      if (!isAlive(workerPid)) startWorker();
    }
  });
});
