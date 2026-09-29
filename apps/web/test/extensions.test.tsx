import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ExtensionsPage from '@/app/extensions/page';
import {
  ALLOWLIST_EMPTY, catalogEntry, extension, installation, mockExtensionsApi, renderExtensionsPage,
  stepTemplate, version,
} from './extensions-helpers';
import { jsonResponse } from './helpers';

/**
 * 扩展管理列表页（M13-W7）：组织维度 + 4 个页签 + 状态机/安装/白名单写操作。
 *
 * 断言口径：
 *  - 所有请求都带 organizationId（后端契约必填；缺省会被判 VALIDATION_ERROR）；
 *  - 状态机按钮按当前状态启用/禁用（与后端前置条件一一对应，服务端仍会再判一次）；
 *  - 失败（403 RBAC 拒绝 / 400 校验）如实呈现为 Badge + Toast，界面状态不被乐观改写。
 */

const panel = (name: string) => within(screen.getByRole('tabpanel', { name }));
const dialog = () => within(screen.getByRole('dialog'));
const lastWrite = (calls: Array<{ url: string; method: string; body: unknown }>, match: string) =>
  [...calls].reverse().find((c) => c.method !== 'GET' && c.url.includes(match));

describe('扩展管理：组织维度与列表', () => {
  it('先取组织列表，默认选中第一个组织，并以 organizationId 拉取扩展', async () => {
    const { calls } = mockExtensionsApi({ extensions: [extension()] });
    renderExtensionsPage(<ExtensionsPage />);

    expect(await screen.findByRole('link', { name: '检索包装' })).toHaveAttribute('href', '/extensions/ext-1');
    expect(screen.getByLabelText('组织')).toHaveValue('org-1');
    expect(calls.some((c) => c.url === '/api/v1/extensions?organizationId=org-1')).toBe(true);
    // 页签懒加载：未切到的页签不发请求
    expect(calls.some((c) => c.url.includes('/catalog?'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/steps?'))).toBe(false);
  });

  it('切换组织后按新 organizationId 重新拉取', async () => {
    const { calls } = mockExtensionsApi({ extensions: [extension()] });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.change(screen.getByLabelText('组织'), { target: { value: 'org-2' } });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/extensions?organizationId=org-2')).toBe(true));
  });

  it('列表行呈现类型/状态/最新版本/安装态', async () => {
    mockExtensionsApi({
      extensions: [extension({
        versions: [version({ version: 3, status: 'published', signature: 'sig' }), version({ id: 'v-2', version: 2, status: 'archived' })],
        installation: installation({ status: 'disabled' }),
      })],
    });
    renderExtensionsPage(<ExtensionsPage />);

    const row = (await screen.findByRole('link', { name: '检索包装' })).closest('tr')!;
    expect(within(row).getByText('wrap-search')).toBeInTheDocument();
    expect(within(row).getByText('工具')).toBeInTheDocument();
    expect(within(row).getByText('draft')).toBeInTheDocument(); // 状态列 = 扩展自身状态（版本状态在“最新版本”列）
    expect(within(row).getByText('v3（published）')).toBeInTheDocument();
    expect(within(row).getByText('已停用')).toBeInTheDocument();
  });

  it('空态：TableEmpty 提示（不静默空白）', async () => {
    mockExtensionsApi({ extensions: [] });
    renderExtensionsPage(<ExtensionsPage />);
    expect(await screen.findByText(/该组织下暂无扩展/)).toBeInTheDocument();
  });
});

describe('扩展管理：状态机按钮按当前状态启用', () => {
  it('draft 且有草稿版本：可发布、不可废弃/归档；无已发布版本时不可安装', async () => {
    mockExtensionsApi({ extensions: [extension({ status: 'draft', versions: [version({ status: 'draft' })] })] });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    expect(panel('我的扩展').getByRole('button', { name: '发布' })).toBeEnabled();
    expect(panel('我的扩展').getByRole('button', { name: '废弃' })).toBeDisabled();
    expect(panel('我的扩展').getByRole('button', { name: '归档' })).toBeDisabled();
    expect(panel('我的扩展').getByRole('button', { name: '编辑' })).toBeEnabled();
    expect(panel('我的扩展').getByRole('button', { name: '安装' })).toBeDisabled();
  });

  it('published 且无草稿：不可发布（幂等保护），可废弃/归档，可安装', async () => {
    mockExtensionsApi({ extensions: [extension({ status: 'published', versions: [version({ status: 'published' })] })] });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    expect(panel('我的扩展').getByRole('button', { name: '发布' })).toBeDisabled();
    expect(panel('我的扩展').getByRole('button', { name: '废弃' })).toBeEnabled();
    expect(panel('我的扩展').getByRole('button', { name: '归档' })).toBeEnabled();
    expect(panel('我的扩展').getByRole('button', { name: '安装' })).toBeEnabled();
  });

  it('archived（终态）：发布/废弃/归档/编辑全部不可用', async () => {
    mockExtensionsApi({ extensions: [extension({ status: 'archived', versions: [version({ status: 'archived' })] })] });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    for (const name of ['发布', '废弃', '归档', '编辑']) {
      expect(panel('我的扩展').getByRole('button', { name })).toBeDisabled();
    }
  });

  it('已安装：提供启用/停用与卸载（按安装态）', async () => {
    mockExtensionsApi({ extensions: [extension({ status: 'published', versions: [version({ status: 'published' })], installation: installation({ status: 'enabled' }) })] });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    expect(panel('我的扩展').getByRole('button', { name: '停用' })).toBeEnabled();
    expect(panel('我的扩展').getByRole('button', { name: '卸载' })).toBeEnabled();
    expect(panel('我的扩展').queryByRole('button', { name: '安装' })).not.toBeInTheDocument();
  });
});

describe('扩展管理：创建/更新', () => {
  it('创建：按后端 DTO 提交（organizationId 必填 + manifest 模板按 slug 生成命名空间）', async () => {
    const { calls } = mockExtensionsApi({ extensions: [extension()] });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(screen.getByRole('button', { name: '创建扩展' }));
    fireEvent.change(dialog().getByLabelText(/名称/), { target: { value: '新检索扩展' } });
    fireEvent.change(dialog().getByLabelText(/slug/), { target: { value: 'new-search' } });
    fireEvent.change(dialog().getByLabelText(/描述/), { target: { value: '包装检索' } });
    fireEvent.click(dialog().getByRole('button', { name: '确认创建' }));

    expect(await screen.findByText('已创建扩展（首版草稿）')).toBeInTheDocument();
    const create = lastWrite(calls, '/api/v1/extensions')!;
    expect(create.method).toBe('POST');
    expect(create.url).toBe('/api/v1/extensions');
    expect(create.body).toMatchObject({
      name: '新检索扩展', slug: 'new-search', kind: 'tool', description: '包装检索', organizationId: 'org-1',
      manifest: { manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'], tool: { name: 'ext.new-search.wrap', baseTool: 'knowledge.search' } },
    });
  });

  it('创建：slug 非法时本地拦截，不发请求', async () => {
    const { calls } = mockExtensionsApi({ extensions: [extension()] });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });
    const before = calls.length;

    fireEvent.click(screen.getByRole('button', { name: '创建扩展' }));
    fireEvent.change(dialog().getByLabelText(/名称/), { target: { value: 'X' } });
    fireEvent.change(dialog().getByLabelText(/slug/), { target: { value: 'Bad_Slug' } });
    fireEvent.click(dialog().getByRole('button', { name: '确认创建' }));

    expect(await screen.findByText(/slug 只能是小写字母/)).toBeInTheDocument();
    expect(calls.length).toBe(before);
  });

  it('更新：仅改名时不发 manifest（服务端不产生新版本）', async () => {
    const { calls } = mockExtensionsApi({ extensions: [extension()] });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(panel('我的扩展').getByRole('button', { name: '编辑' }));
    fireEvent.change(dialog().getByLabelText(/名称/), { target: { value: '改名后的扩展' } });
    fireEvent.click(dialog().getByRole('button', { name: '保存变更' }));

    expect(await screen.findByText('已更新扩展')).toBeInTheDocument();
    const patch = lastWrite(calls, '/api/v1/extensions/ext-1')!;
    expect(patch.method).toBe('PATCH');
    expect(patch.body).toEqual({ name: '改名后的扩展' });
  });
});

describe('扩展管理：状态机写操作与 RBAC 如实呈现', () => {
  it('发布：POST /publish 并 Toast 反馈', async () => {
    const { calls } = mockExtensionsApi({ extensions: [extension({ status: 'draft', versions: [version({ status: 'draft' })] })] });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(panel('我的扩展').getByRole('button', { name: '发布' }));
    expect(await screen.findByText('已发布扩展')).toBeInTheDocument();
    expect(lastWrite(calls, '/publish')!.url).toBe('/api/v1/extensions/ext-1/publish');
  });

  it('废弃：需二次确认（不确认不发请求）', async () => {
    const { calls } = mockExtensionsApi({ extensions: [extension({ status: 'published', versions: [version({ status: 'published' })] })] });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(panel('我的扩展').getByRole('button', { name: '废弃' }));
    expect(screen.getByText(/废弃即下线/)).toBeInTheDocument();
    fireEvent.click(dialog().getByRole('button', { name: '取消' }));
    expect(lastWrite(calls, '/deprecate')).toBeUndefined();

    fireEvent.click(panel('我的扩展').getByRole('button', { name: '废弃' }));
    fireEvent.click(dialog().getByRole('button', { name: '确认废弃' }));
    expect(await screen.findByText('已废弃扩展（已下线）')).toBeInTheDocument();
    expect(lastWrite(calls, '/deprecate')!.url).toBe('/api/v1/extensions/ext-1/deprecate');
  });

  it('归档：published 可归档，确认后 POST /archive', async () => {
    const { calls } = mockExtensionsApi({ extensions: [extension({ status: 'published', versions: [version({ status: 'published' })] })] });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(panel('我的扩展').getByRole('button', { name: '归档' }));
    fireEvent.click(dialog().getByRole('button', { name: '确认归档' }));
    expect(await screen.findByText('已归档扩展')).toBeInTheDocument();
    expect(lastWrite(calls, '/archive')!.url).toBe('/api/v1/extensions/ext-1/archive');
  });

  it('403（RBAC 拒绝）：如实呈现 403 Badge + 失败 Toast，状态不被乐观改写', async () => {
    mockExtensionsApi({
      extensions: [extension({ status: 'draft', versions: [version({ status: 'draft' })] })],
      write: (url) => (url.endsWith('/publish')
        ? jsonResponse({ error: { code: 'FORBIDDEN', message: '权限不足' } }, 403)
        : undefined),
    });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(panel('我的扩展').getByRole('button', { name: '发布' }));

    expect(await screen.findByText('403 FORBIDDEN')).toBeInTheDocument();
    expect(screen.getByText('发布失败')).toBeInTheDocument();
    // 服务端原文同时出现在 Badge 旁与 Toast 里（如实呈现，不吞错）
    expect(screen.getAllByText('权限不足').length).toBeGreaterThan(0);
    // 状态未变：仍是 draft，发布按钮仍可用（未被乐观改成 published）
    expect(panel('我的扩展').getByText('draft')).toBeInTheDocument();
    expect(panel('我的扩展').getByRole('button', { name: '发布' })).toBeEnabled();
  });

  it('组织禁用（ORG_DISABLED）：同样按 403 呈现', async () => {
    mockExtensionsApi({
      extensions: [extension({ status: 'published', versions: [version({ status: 'published' })], installation: installation({ status: 'enabled' }) })],
      write: (url) => (url.endsWith('/disable')
        ? jsonResponse({ error: { code: 'ORG_DISABLED', message: '组织已被禁用，无法访问其资源' } }, 403)
        : undefined),
    });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(panel('我的扩展').getByRole('button', { name: '停用' }));
    expect(await screen.findByText('403 ORG_DISABLED')).toBeInTheDocument();
    expect(screen.getByText('停用失败')).toBeInTheDocument();
  });
});

describe('扩展管理：安装 / 卸载 / 启停', () => {
  it('安装：默认最新已发布版本 + 组织 config', async () => {
    const { calls } = mockExtensionsApi({ extensions: [extension({ status: 'published', versions: [version({ status: 'published' })] })] });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(panel('我的扩展').getByRole('button', { name: '安装' }));
    fireEvent.change(dialog().getByLabelText(/安装配置/), { target: { value: '{"region":"cn"}' } });
    fireEvent.click(dialog().getByRole('button', { name: '确认安装' }));

    expect(await screen.findByText('已安装扩展')).toBeInTheDocument();
    const call = lastWrite(calls, '/install')!;
    expect(call.url).toBe('/api/v1/extensions/ext-1/install');
    expect(call.body).toEqual({ organizationId: 'org-1', config: { region: 'cn' } });
  });

  it('provider 类安装：未填 apiKey 时本地拦截（服务端也会拒绝）', async () => {
    const { calls } = mockExtensionsApi({
      extensions: [extension({ kind: 'provider', status: 'published', versions: [version({ status: 'published' })] })],
    });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });
    const before = calls.length;

    fireEvent.click(panel('我的扩展').getByRole('button', { name: '安装' }));
    fireEvent.click(dialog().getByRole('button', { name: '确认安装' }));
    expect(await screen.findByText(/必须提供 apiKey/)).toBeInTheDocument();
    expect(calls.length).toBe(before);

    fireEvent.change(dialog().getByLabelText(/apiKey/), { target: { value: 'sk-test-123' } });
    fireEvent.click(dialog().getByRole('button', { name: '确认安装' }));
    await screen.findByText('已安装扩展');
    expect(lastWrite(calls, '/install')!.body).toEqual({ organizationId: 'org-1', config: { apiKey: 'sk-test-123' } });
  });

  it('卸载：二次确认后 POST /uninstall（带 organizationId）', async () => {
    const { calls } = mockExtensionsApi({
      extensions: [extension({ status: 'published', versions: [version({ status: 'published' })], installation: installation() })],
    });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(panel('我的扩展').getByRole('button', { name: '卸载' }));
    fireEvent.click(dialog().getByRole('button', { name: '确认卸载' }));
    expect(await screen.findByText('已卸载扩展')).toBeInTheDocument();
    const call = lastWrite(calls, '/uninstall')!;
    expect(call.url).toBe('/api/v1/extensions/ext-1/uninstall');
    expect(call.body).toEqual({ organizationId: 'org-1' });
  });

  it('启停：已启用→停用，已停用→启用（POST /disable · /enable）', async () => {
    const { calls } = mockExtensionsApi({
      extensions: [extension({ status: 'published', versions: [version({ status: 'published' })], installation: installation({ status: 'enabled' }) })],
    });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(panel('我的扩展').getByRole('button', { name: '停用' }));
    expect(await screen.findByText('已停用扩展')).toBeInTheDocument();
    expect(lastWrite(calls, '/disable')!.body).toEqual({ organizationId: 'org-1' });
  });
});

describe('扩展管理：白名单（读/加/删）', () => {
  it('打开白名单：读出受限标记与条目，可加入与移出', async () => {
    const { calls } = mockExtensionsApi({
      extensions: [extension()],
      allowlist: { extensionId: 'ext-1', restricted: true, items: [{ organizationId: 'org-9', createdAt: '2026-09-22T00:00:00.000Z' }] },
    });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(panel('我的扩展').getByRole('button', { name: '白名单' }));
    expect(await screen.findByText('受限可见：仅白名单组织可安装')).toBeInTheDocument();
    expect(dialog().getByText('org-9')).toBeInTheDocument();

    // 加入（org-2）
    fireEvent.change(dialog().getByLabelText('白名单组织'), { target: { value: 'org-2' } });
    fireEvent.click(dialog().getByRole('button', { name: '加入白名单' }));
    expect(await screen.findByText('已加入白名单')).toBeInTheDocument();
    const add = lastWrite(calls, '/allowlist')!;
    expect(add.method).toBe('POST');
    expect(add.url).toBe('/api/v1/extensions/ext-1/allowlist');
    expect(add.body).toEqual({ organizationId: 'org-2' });

    // 移出（org-9）
    fireEvent.click(dialog().getByRole('button', { name: '移出白名单' }));
    expect(await screen.findByText('已移出白名单')).toBeInTheDocument();
    const remove = [...calls].reverse().find((c) => c.method === 'DELETE')!;
    expect(remove.url).toBe('/api/v1/extensions/ext-1/allowlist/org-9');
  });

  it('未设置白名单：明示「全部组织可安装」', async () => {
    mockExtensionsApi({ extensions: [extension()], allowlist: ALLOWLIST_EMPTY });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(panel('我的扩展').getByRole('button', { name: '白名单' }));
    expect(await screen.findByText('未设置白名单：全部组织可安装')).toBeInTheDocument();
    expect(dialog().getByText('白名单为空（当前未限制安装范围）')).toBeInTheDocument();
  });
});

describe('扩展管理：市场目录 / 安装记录 / 步骤模板页签', () => {
  it('市场目录：已发布条目可安装（已安装或未发布的禁用）', async () => {
    const { calls } = mockExtensionsApi({
      extensions: [extension()],
      catalog: [
        catalogEntry(),
        catalogEntry({
          id: 'ext-2', name: '已装扩展', slug: 'installed', scope: 'organization',
          publishedVersion: null, installation: installation({ extensionId: 'ext-2' }),
        }),
      ],
    });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(screen.getByRole('tab', { name: '市场目录' }));
    expect(await panel('市场目录').findByRole('link', { name: '检索包装' })).toBeInTheDocument();
    expect(panel('市场目录').getByText('平台级')).toBeInTheDocument();
    const installButtons = panel('市场目录').getAllByRole('button', { name: '安装' });
    expect(installButtons[0]).toBeEnabled();   // 已发布且未安装
    expect(installButtons[1]).toBeDisabled();  // 未发布/已安装
    expect(panel('市场目录').getByText('已启用')).toBeInTheDocument();

    expect(calls.some((c) => c.url === '/api/v1/extensions/catalog?organizationId=org-1')).toBe(true);
  });

  it('安装记录：锁定版本与启停/卸载操作', async () => {
    const { calls } = mockExtensionsApi({
      extensions: [extension()],
      installations: [installation({ status: 'disabled', extension: extension(), pinnedVersion: version({ status: 'published' }) })],
    });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(screen.getByRole('tab', { name: '安装记录' }));
    const rows = await panel('安装记录').findByText(/安装行锁定版本/);
    expect(rows).toBeInTheDocument();
    expect(panel('安装记录').getByText('v1')).toBeInTheDocument();
    expect(panel('安装记录').getByRole('button', { name: '启用' })).toBeEnabled();
    expect(panel('安装记录').getByRole('button', { name: '卸载' })).toBeEnabled();
    expect(calls.some((c) => c.url === '/api/v1/extensions/installations?organizationId=org-1')).toBe(true);
  });

  it('步骤模板：只读展示声明（无任何执行入口 —— 扩展链禁止）', async () => {
    mockExtensionsApi({ extensions: [extension({ kind: 'workflow_step' })], steps: [stepTemplate()] });
    renderExtensionsPage(<ExtensionsPage />);
    await screen.findByRole('link', { name: '检索包装' });

    fireEvent.click(screen.getByRole('tab', { name: '步骤模板' }));
    const stepsPanel = panel('步骤模板');
    expect(await stepsPanel.findByText('search_step')).toBeInTheDocument();
    expect(stepsPanel.getByText('{"toolName":"knowledge.search"}')).toBeInTheDocument();
    // 只读：面板内不得出现任何运行/执行类按钮
    expect(stepsPanel.queryByRole('button', { name: /运行|执行/ })).toBeNull();
  });
});
