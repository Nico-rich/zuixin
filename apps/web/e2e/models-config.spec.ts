import { expect, openChat, sendChat, test } from './support/fixtures';

/**
 * M13+ 模型配置页（首个 admin 页面 spec）。
 *
 * 闭环（真实 API + 真实浏览器）：
 * ① 导航 → /settings/models 渲染 Provider 表，无页面错误；
 * ② 编辑弹窗：apiKey 输入是 password 且初值空（只写不回显）；
 * ③ **无模型 UX**：快照后停用全部 llm provider → 发消息 → 出现「前往模型配置」引导
 *    （div[data-testid=provider-unavailable-hint]，**不是** p.text-red-400）→ 恢复启用 → 再发 → 助手回复恢复；
 * ④ 默认模型：切 llm 默认模型 → 保存 → 读回 routingPolicy 值已变。
 *
 * 副作用治理：provider enabled 快照-还原放 finally；默认模型 afterAll 还原为 seed-model-mock-echo
 * （routingPolicy.defaults 只是排序偏好，不影响其他套件，但保持共享库整洁）。
 */
const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

interface ApiProvider { id: string; name: string; type: string; enabled: boolean; hasKey: boolean; models: Array<{ id: string; name: string; type: string; enabled: boolean }> }

async function fetchProviders(page: import('@playwright/test').Page): Promise<ApiProvider[]> {
  const res = await page.request.get('/api/v1/providers', { headers: XRW });
  const body = await res.json();
  return (body.data as { providers: ApiProvider[] }).providers;
}

async function patchProvider(page: import('@playwright/test').Page, id: string, patch: Record<string, unknown>): Promise<void> {
  const res = await page.request.patch(`/api/v1/providers/${id}`, { headers: XRW, data: patch });
  if (!res.ok()) throw new Error(`PATCH provider ${id} 失败: ${res.status()} ${await res.text()}`);
}

test.describe('模型配置页（admin）', () => {
  test('无模型 UX 闭环：全停 llm → 对话引导 → 恢复 → 对话恢复', async ({ authedPage: page }) => {
    test.setTimeout(300_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    // 快照 llm providers 的启用态（finally 还原）
    const before = (await fetchProviders(page)).filter((p) => p.type === 'llm');

    try {
      // ① 页面真实可达
      await page.goto('/settings/models');
      await expect(page.getByRole('heading', { name: '模型配置' })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText('本地Mock')).toBeVisible();
      await expect(page.locator('p.text-red-400')).toHaveCount(0);

      // ② apiKey 只写不回显
      await page.getByRole('button', { name: '编辑' }).first().click();
      const keyInput = page.getByTestId('provider-apikey');
      await expect(keyInput).toBeVisible();
      expect(await keyInput.getAttribute('type')).toBe('password');
      expect(await keyInput.inputValue()).toBe('');
      await page.getByRole('button', { name: '取消' }).click();

      // ③ 全停 llm → 对话出引导
      for (const p of before) {
        if (p.enabled) await patchProvider(page, p.id, { enabled: false });
      }
      await openChat(page);
      await sendChat(page, '随便说点什么');
      const hint = page.getByTestId('provider-unavailable-hint');
      await expect(hint).toBeVisible({ timeout: 60_000 });
      await expect(hint.getByRole('link', { name: /前往模型配置/ })).toHaveAttribute('href', '/settings/models');
      await expect(page.locator('p.text-red-400')).toHaveCount(0); // 可恢复配置态 ≠ 页面错误

      // 恢复 → 对话恢复
      for (const p of before) {
        if (p.enabled) await patchProvider(page, p.id, { enabled: true });
      }
      await sendChat(page, '你好，介绍一下你自己');
      const bubble = page.locator('div.group').last();
      await expect(bubble).toContainText(/mock|你好|介绍/, { timeout: 120_000 });
      await expect(page.locator('p.text-red-400')).toHaveCount(0);
    } finally {
      for (const p of before) {
        await patchProvider(page, p.id, { enabled: p.enabled }).catch(() => undefined);
      }
    }
    expect(pageErrors).toEqual([]);
  });

  test('默认模型切换：保存 → routingPolicy 读回已变（快照还原）', async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    // 快照当前 llm 默认值（还原不硬编码 mock id——用户在配置页可能已停用 mock 模型）
    const beforeRes = await page.request.get('/api/v1/system-settings/routingPolicy', { headers: XRW });
    const beforeBody = await beforeRes.json();
    const beforeDefault: string | null = (beforeBody.data.value as { defaults?: Record<string, string | null> })?.defaults?.llm ?? null;

    // 找一个非 mock 的 llm 模型 id 作为切换目标（provider 可停用——defaults 不要求 provider 启用）
    const providers = await fetchProviders(page);
    const target = providers.flatMap((p) => p.models).find((m) => m.type === 'llm' && m.id !== 'seed-model-mock-echo');
    if (!target) { test.skip(true, '无可用切换目标模型'); return; }

    try {
      await page.goto('/settings/models');
      const select = page.getByLabel('LLM（对话/Agent） 默认模型');
      await expect(select).toBeVisible({ timeout: 60_000 });
      await select.selectOption(target.id);
      await page.getByRole('button', { name: '保存' }).first().click();
      await expect(page.getByText('默认模型已更新')).toBeVisible({ timeout: 30_000 });

      const res = await page.request.get('/api/v1/system-settings/routingPolicy', { headers: XRW });
      const body = await res.json();
      expect((body.data.value as { defaults: Record<string, string> }).defaults.llm).toBe(target.id);
    } finally {
      await page.request.patch('/api/v1/system-settings/routingPolicy', {
        headers: XRW, data: { defaults: { llm: beforeDefault } },
      }).catch(() => undefined);
    }
  });
});
