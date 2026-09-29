import { expect, test, uniqueTag } from './support/fixtures';

/**
 * 覆盖点 6：marketplace / workflows / evaluation 三个**只读**页面在真实浏览器里的渲染与空态。
 *
 * 断言口径：
 * - 页面必须收敛到「有数据（列表行可见）」或「明确空态」之一，绝不长期停在“加载中…”或错误态；
 * - 全程无未捕获异常（pageerror）—— 只读页最容易死在未处理的 fetch/渲染异常上；
 * - 只读语义：不出现任何写操作按钮（本页无写入口是产品口径，见各页头部注释）。
 */
const WRITE_BUTTON = /安装|发布|删除|创建|新建|运行|保存|提交|导入|上传/;

function trackPageErrors(page: import('@playwright/test').Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err.message ?? err)));
  return errors;
}

test.describe('只读页面（marketplace / workflows / evaluation）', () => {
  test('marketplace：列表/空态 + 关键词搜索空态 + 只读（无写入口）', async ({ authedPage: page }) => {
    const errors = trackPageErrors(page);
    await page.goto('/marketplace');

    await expect(page.getByRole('heading', { name: '扩展市场' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/共 \d+ 个已上架条目/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel('关键词')).toBeVisible();
    await expect(page.getByLabel('分类')).toBeVisible();
    await expect(page.locator('p.text-red-400')).toHaveCount(0);
    // 只读：列表页不提供安装/发布/删除等写操作（搜索按钮除外）
    await expect(page.getByRole('button', { name: WRITE_BUTTON })).toHaveCount(0);

    // 空态：唯一关键词 → 命中 0 条（确定性收敛，不依赖既有种子数据）
    await page.getByLabel('关键词').fill(uniqueTag('no-such-extension'));
    await page.getByRole('button', { name: '搜索' }).click();
    await expect(page.getByText('共 0 个已上架条目')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('没有匹配的扩展')).toBeVisible();
    await expect(page.locator('ul > li')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('workflows：列表或空态渲染，无错误态与未捕获异常', async ({ authedPage: page }) => {
    const errors = trackPageErrors(page);
    await page.goto('/workflows');

    await expect(page.getByRole('heading', { name: '工作流' })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('p.text-zinc-500', { hasText: '加载中…' })).toHaveCount(0);
    const rows = page.locator('ul > li');
    if ((await rows.count()) === 0) {
      await expect(page.getByText('暂无工作流')).toBeVisible();
    } else {
      await expect(rows.first()).toBeVisible();
      // 每行都带状态徽标与版本/运行次数投影
      await expect(rows.first()).toContainText(/v\d+ · \d+ 次运行/);
      await expect(rows.first().locator('span.rounded')).toHaveText(/draft|published|archived/);
    }
    await expect(page.locator('p.text-red-400')).toHaveCount(0);
    await expect(page.getByRole('button', { name: WRITE_BUTTON })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('evaluation：三个只读分区（数据集/评测运行/实验）各自收敛为列表或空态', async ({ authedPage: page }) => {
    const errors = trackPageErrors(page);
    await page.goto('/evaluation');

    await expect(page.getByRole('heading', { name: '评测' })).toBeVisible({ timeout: 60_000 });

    const sections: Array<[string, string]> = [
      ['数据集', '暂无数据集'],
      ['评测运行', '暂无运行'],
      ['实验', '暂无实验'],
    ];
    for (const [title, emptyText] of sections) {
      const section = page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(section, `分区「${title}」应唯一存在`).toHaveCount(1);
      await expect(section.getByText('加载中…')).toHaveCount(0);
      const rows = section.locator('li');
      if ((await rows.count()) === 0) {
        await expect(section.getByText(emptyText)).toBeVisible();
      } else {
        await expect(rows.first()).toBeVisible();
      }
    }

    // 只读口径：写路径只在 API 侧（evaluation.write），页面无任何写入口
    await expect(page.getByRole('button', { name: WRITE_BUTTON })).toHaveCount(0);
    await expect(page.locator('p.text-red-400')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
