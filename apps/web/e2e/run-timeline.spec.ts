import { expect, openChat, sendChat, test, timelineRow, uniqueTag, waitForChatSettled } from './support/fixtures';

/**
 * 覆盖点 3：run-timeline（执行详情面板）在真实浏览器里的状态与图标渲染。
 *
 * 面板数据来自 GET /api/v1/agent-runs/:runId/timeline（真实投影服务），展开时拉取一次并缓存。
 */
test.describe('run-timeline 执行详情（真实浏览器）', () => {
  test('运行中（非终态）：展开即见 ▶ 开始项、无终态项、头部状态为 running', async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    await openChat(page);
    await sendChat(page, `请用两句话解释什么是缓存穿透 ${uniqueTag('rt-live')}`);

    // run.created 到达即出现“执行详情”；此刻展开 → 面板快照是运行中
    const toggle = page.getByRole('button', { name: '执行详情' });
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    await toggle.click();

    await expect(timelineRow(page, 'Agent 开始执行')).toContainText('▶');
    await expect(toggle).toContainText(/项 · (running|queued)/, { timeout: 60_000 });
    await expect(page.locator('div.flex.items-start.gap-2.py-1').filter({ hasText: 'Agent 完成' })).toHaveCount(0);

    // 收束后本轮消息仍完整（运行中展开不打断 SSE）
    await waitForChatSettled(page);
    await expect(page.locator('p.text-red-400')).toHaveCount(0);
  });

  test('终态 completed：✅ Agent 完成 / 💬 最终回答 / 📊 用量汇总 全部渲染', async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    await openChat(page);
    const tag = uniqueTag('rt-done');
    await sendChat(page, `一句话说明什么是幂等 ${tag}`);
    await waitForChatSettled(page);

    const toggle = page.getByRole('button', { name: '执行详情' });
    await expect(toggle).toHaveCount(1);
    await toggle.click();
    await expect(toggle).toContainText(/项 · completed/, { timeout: 60_000 });

    await expect(timelineRow(page, 'Agent 开始执行')).toContainText('▶');
    await expect(timelineRow(page, '最终回答')).toContainText('💬');
    await expect(timelineRow(page, 'Agent 完成')).toContainText('✅');
    await expect(timelineRow(page, '用量汇总')).toContainText('📊');
    await expect(timelineRow(page, '用量汇总')).toContainText(/LLM 回合 \d+/);
    // 终态项不应出现失败类文案
    await expect(page.locator('div.flex.items-start.gap-2.py-1').filter({ hasText: 'Agent 失败' })).toHaveCount(0);
  });

  test('工具调用项：🔧 工具名 + 安全摘要（不外泄 raw input/output）', async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    await openChat(page);
    const tag = uniqueTag('rt-tool');
    await sendChat(page, `请记住 ${tag} 我偏好深蓝色`);
    await waitForChatSettled(page);

    const toggle = page.getByRole('button', { name: '执行详情' });
    await expect(toggle).toHaveCount(1);
    await toggle.click();
    await expect(toggle).toContainText(/项 · completed/, { timeout: 60_000 });

    await expect(timelineRow(page, /步骤 1/)).toContainText('1 个工具调用');
    const toolRow = timelineRow(page, 'memory.create_candidate');
    await expect(toolRow).toContainText('🔧');
    await expect(toolRow).toContainText('已记录记忆候选');
    // 安全化：摘要口径固定，不出现原始入参（本用例的原始入参含唯一标记）
    await expect(timelineRow(page, 'memory.create_candidate')).not.toContainText(tag);
  });

  /**
   * run.waiting（⏸ 等待生成任务完成）在浏览器侧**不可达**——非功能缺陷，而是 mock 配置的必然结果：
   * - `run.waiting` 项只在 run.status === 'waiting' 时投影（agent-run-timeline.service.ts）；
   * - run 进入 waiting 的唯一运行时写入者是 `enterWaiting(runId, taskId)`，由 **Agent Loop 内的工具调用**
   *   （image.generate / video.generate 返回 taskId）触发（agent-runtime-engine.ts → prisma-runtime-persistence.ts）；
   * - 而 mock 路由（MockRouterAdapter）与 mock LLM 工具启发式（MockLLMAdapter.maybeToolCall）的图像/视频
   *   关键词正则**完全同源**（/图|图片|海报|主图|插画|logo|图标|banner/i、/视频|短片|动画/i）：
   *   凡能触发这两个工具的消息，必被分类为 image_generation / video_generation → 直连 Image/Video Agent
   *   （**不产生 AgentRun**）。因此浏览器可见的 AgentRun 永远不会走 waiting 分支。
   * 解除条件（届时把本用例改回 test 即可）：把 routingPolicy.routerModelId 换成真实路由模型（分类与工具
   * 启发式解耦），或在受控环境把 agentMapping.image_generation 指向 general-assistant。
   * 该分支的服务端覆盖：M6-P4（任务等待）/M7-P1（审批等待）用例 + web 单测 run-timeline.test.tsx。
   */
  test.fixme('等待态（⏸）等待生成任务/人工审批：见上方不可达说明', async () => {
    expect(true).toBe(true);
  });
});
