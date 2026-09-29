import { expect, test, uniqueTag } from './support/fixtures';

/**
 * 覆盖点 6：marketplace / workflows / evaluation 三个页面的真实浏览器渲染、空态与写入口可见性。
 *
 * 断言口径：
 * - 页面必须收敛到「有数据（列表行可见）」或「明确空态」之一，绝不长期停在“加载中…”或错误态；
 * - 全程无未捕获异常（pageerror）—— 只读页最容易死在未处理的 fetch/渲染异常上；
 * - 写入口：
 *   · marketplace 仍**无**任何写操作按钮（安装/发布在扩展管理页，不在此处）；
 *   · workflows / evaluation 自 M13-W10 起有写入口（新建工作流 / 新建数据集·运行·实验）。
 *     入口**不按权限隐藏**——权限由服务端裁决（workflow.write / evaluation.write，仅 owner/admin），
 *     403 由页面渲染成权限徽标（WriteError）。因此这里断言的是「入口存在且页面无错误态」，
 *     而不是「没有写按钮」。表单提交类行为由组件单测覆盖（本 spec 不实际写入数据）。
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

  test('workflows：列表或空态渲染 + 新建入口可见，无错误态与未捕获异常', async ({ authedPage: page }) => {
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
    // M13-W10 写入口（弹窗初始不渲染，不污染列表选择器口径）
    await expect(page.getByRole('button', { name: '新建工作流' })).toBeVisible();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.locator('p.text-red-400')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('evaluation：三个分区（数据集/评测运行/实验）各自收敛为列表或空态 + 写入口可见', async ({ authedPage: page }) => {
    const errors = trackPageErrors(page);
    await page.goto('/evaluation');

    await expect(page.getByRole('heading', { name: '评测', exact: true })).toBeVisible({ timeout: 60_000 }); // 子串匹配会撞上『评测运行』

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

    // M13-W10 写入口（三个分区各一；权限由服务端 evaluation.write 裁决，入口不隐藏）
    await expect(page.getByRole('button', { name: '新建数据集' })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建评测运行' })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建实验' })).toBeVisible();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0); // 弹窗初始不渲染
    // 写入口按钮不得破坏分区选择器口径（section + heading 各一）
    await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: '数据集', exact: true }) })).toHaveCount(1);
    await expect(page.locator('p.text-red-400')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
