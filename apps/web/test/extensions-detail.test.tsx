import { Suspense } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ExtensionDetailPage from '@/app/extensions/[id]/page';
import { ALLOWLIST_EMPTY, extension, installation, mockExtensionsApi, renderExtensionsPage, stepTemplate, version } from './extensions-helpers';
import { jsonResponse } from './helpers';

/**
 * 扩展详情页（M13-W7）：信息 / 版本（不可变快照 + 按版本发布）/ 安装态 / 步骤清单 / 白名单。
 *
 * 页面用 React 19 `use(params)` 取路由参数 → render 必须包在 async act 里，
 * 否则 Suspense 边界外的 promise 决议不会被 flush（测试会停在 fallback）。
 */

const detail = (overrides: Record<string, unknown> = {}) => extension(overrides);

async function renderDetail(routes: Parameters<typeof mockExtensionsApi>[0] = {}) {
  const api = mockExtensionsApi({ extensions: [detail()], ...routes });
  await act(async () => {
    renderExtensionsPage(
      <Suspense fallback={<p>页面加载中…</p>}>
        <ExtensionDetailPage params={Promise.resolve({ id: 'ext-1' })} />
      </Suspense>,
    );
  });
  return api;
}

/** 标题行（h1 + 状态/类型/归属徽标 + slug）：与版本表里的 status 文本区分开 */
const header = () => within(screen.getByRole('heading', { name: '检索包装' }).parentElement!);
/** 卡片作用域：CardTitle 是 h3，closest('div') = CardHeader，其父 = Card */
const card = (title: string) => within(screen.getByText(title, { selector: 'h3' }).closest('div')!.parentElement!);

describe('扩展详情：信息与版本', () => {
  it('呈现名称/状态/类型/归属/slug 与版本快照（权限投影、checksum 前缀、签名）', async () => {
    await renderDetail({
      extensions: [detail({
        status: 'published',
        versions: [
          version({ version: 2, status: 'published', signature: 'sig' }),
          version({ id: 'v-1', version: 1, status: 'archived' }),
        ],
      })],
    });

    expect(await screen.findByRole('heading', { name: '检索包装' })).toBeInTheDocument();
    expect(header().getByText('published')).toBeInTheDocument();
    expect(header().getByText('工具')).toBeInTheDocument();
    expect(header().getByText('组织私有')).toBeInTheDocument();
    expect(screen.getByText('wrap-search')).toBeInTheDocument();

    const versionsCard = card('状态机与版本');
    expect(versionsCard.getByText('v2')).toBeInTheDocument();
    expect(versionsCard.getByText('v1')).toBeInTheDocument();
    expect(versionsCard.getAllByText('tool.execute').length).toBe(2); // 每版本一条权限投影
    expect(versionsCard.getAllByText(/^a{12}…$/).length).toBe(2); // checksum 只展示前 12 位
    expect(versionsCard.getByText('已签名')).toBeInTheDocument();
    expect(versionsCard.getByText('未签名')).toBeInTheDocument();
  });

  it('archived 终态：发布/废弃/归档/编辑/按版本发布全部禁用', async () => {
    await renderDetail({ extensions: [detail({ status: 'archived', versions: [version({ status: 'archived' })] })] });
    await screen.findByRole('heading', { name: '检索包装' });

    expect(screen.getByRole('button', { name: '发布最新草稿' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '废弃' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '归档' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '编辑' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '发布该版本' })).toBeDisabled();
  });

  it('发布指定草稿版本：POST /publish 带 versionId（按版本发布，不是最新）', async () => {
    const { calls } = await renderDetail({
      extensions: [detail({
        versions: [version({ id: 'v-2', version: 2, status: 'draft' }), version({ id: 'v-1', version: 1, status: 'archived' })],
      })],
    });
    await screen.findByRole('heading', { name: '检索包装' });

    const rows = card('状态机与版本').getAllByRole('button', { name: '发布该版本' });
    fireEvent.click(rows[0]); // v2（draft）
    expect(await screen.findByText('已发布版本')).toBeInTheDocument();

    const publish = calls.find((c) => c.method === 'POST' && c.url.endsWith('/publish'))!;
    expect(publish.url).toBe('/api/v1/extensions/ext-1/publish');
    expect(publish.body).toEqual({ versionId: 'v-2' });
  });

  it('加载失败（403）：整页如实呈现 403 Badge 与服务端消息', async () => {
    mockExtensionsApi({
      read: (url) => (url.startsWith('/api/v1/extensions/ext-1?')
        ? jsonResponse({ error: { code: 'FORBIDDEN', message: '无权访问该组织' } }, 403)
        : undefined),
    });
    await act(async () => {
      renderExtensionsPage(
        <Suspense fallback={<p>页面加载中…</p>}>
          <ExtensionDetailPage params={Promise.resolve({ id: 'ext-1' })} />
        </Suspense>,
      );
    });

    expect(await screen.findByText('403 FORBIDDEN')).toBeInTheDocument();
    expect(screen.getByText('无权访问该组织')).toBeInTheDocument();
  });

  it('加载失败（404）：呈现 404 Badge', async () => {
    mockExtensionsApi({
      read: (url) => (url.startsWith('/api/v1/extensions/ext-1?')
        ? jsonResponse({ error: { code: 'NOT_FOUND', message: '扩展不存在' } }, 404)
        : undefined),
    });
    await act(async () => {
      renderExtensionsPage(
        <Suspense fallback={<p>页面加载中…</p>}>
          <ExtensionDetailPage params={Promise.resolve({ id: 'ext-1' })} />
        </Suspense>,
      );
    });

    expect(await screen.findByText('404 NOT_FOUND')).toBeInTheDocument();
  });
});

describe('扩展详情：安装态', () => {
  it('未安装：弹窗确认后 POST /install（锁定版本 + 当前组织）', async () => {
    const { calls } = await renderDetail({
      extensions: [detail({ status: 'published', versions: [version({ status: 'published' })] })],
    });
    await screen.findByRole('heading', { name: '检索包装' });
    expect(screen.getByText('当前组织未安装该扩展')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认安装' }));

    expect(await screen.findByText('已安装扩展')).toBeInTheDocument();
    const install = calls.find((c) => c.method === 'POST' && c.url.endsWith('/install'))!;
    expect(install.url).toBe('/api/v1/extensions/ext-1/install');
    expect(install.body).toEqual({ organizationId: 'org-1', config: {} });
  });

  it('已安装（停用态）：显示锁定版本与安装配置，可启用、可卸载（卸载需确认）', async () => {
    const { calls } = await renderDetail({
      extensions: [detail({
        status: 'published',
        versions: [version({ status: 'published' })],
        installation: installation({ status: 'disabled', config: { region: 'cn' } }),
      })],
    });
    await screen.findByRole('heading', { name: '检索包装' });

    const installCard = card('安装（当前组织）');
    expect(installCard.getByText('已停用')).toBeInTheDocument();
    expect(installCard.getByText(/^锁定版本/)).toHaveTextContent('v1');
    expect(installCard.getByText(/region/)).toBeInTheDocument();

    fireEvent.click(installCard.getByRole('button', { name: '启用' }));
    expect(await screen.findByText('已启用扩展')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/enable'))).toBe(true));

    fireEvent.click(installCard.getByRole('button', { name: '卸载' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认卸载' }));
    expect(await screen.findByText('已卸载扩展')).toBeInTheDocument();
    const uninstall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/uninstall'))!;
    expect(uninstall.body).toEqual({ organizationId: 'org-1' });
  });

  it('已安装（启用态）：显示「停用」而非「启用」', async () => {
    await renderDetail({
      extensions: [detail({
        status: 'published',
        versions: [version({ status: 'published' })],
        installation: installation({ status: 'enabled' }),
      })],
    });
    await screen.findByRole('heading', { name: '检索包装' });

    const installCard = card('安装（当前组织）');
    expect(installCard.getByText('已启用')).toBeInTheDocument();
    expect(installCard.getByRole('button', { name: '停用' })).toBeInTheDocument();
    expect(installCard.queryByRole('button', { name: '启用' })).toBeNull();
  });
});

describe('扩展详情：workflow_step 步骤清单（只读）', () => {
  it('列出该扩展的步骤模板，且不提供任何执行入口', async () => {
    const { calls } = await renderDetail({
      extensions: [detail({ kind: 'workflow_step', versions: [version({ status: 'published' })] })],
      steps: [stepTemplate(), stepTemplate({ extensionId: 'ext-9', name: 'other_step' })],
    });
    await screen.findByRole('heading', { name: '检索包装' });

    const stepsCard = card('步骤清单');
    expect(await stepsCard.findByText('search_step')).toBeInTheDocument();
    expect(stepsCard.getByText('检索步骤')).toBeInTheDocument();
    expect(stepsCard.getByText('{"toolName":"knowledge.search"}')).toBeInTheDocument();
    // 只按当前扩展过滤（同一端点返回该组织的全部步骤模板）
    expect(stepsCard.queryByText('other_step')).toBeNull();
    // 扩展链禁止：页面不得出现运行/执行扩展的入口
    expect(stepsCard.queryByRole('button', { name: /运行|执行/ })).toBeNull();
    expect(calls.some((c) => c.url === '/api/v1/extensions/steps?organizationId=org-1')).toBe(true);
  });

  it('非 workflow_step 类扩展不渲染步骤卡片、也不请求步骤端点', async () => {
    const { calls } = await renderDetail({ extensions: [detail({ kind: 'tool' })] });
    await screen.findByRole('heading', { name: '检索包装' });

    expect(screen.queryByText('步骤清单', { selector: 'h3' })).toBeNull();
    expect(calls.some((c) => c.url.includes('/steps?'))).toBe(false);
  });
});

describe('扩展详情：组织白名单', () => {
  it('读出条目并可移出（DELETE 落到 /allowlist/:organizationId）', async () => {
    const { calls } = await renderDetail({
      allowlist: { extensionId: 'ext-1', restricted: true, items: [{ organizationId: 'org-9', createdAt: '2026-09-22T00:00:00.000Z' }] },
    });
    await screen.findByRole('heading', { name: '检索包装' });

    const allowCard = card('组织白名单');
    expect(await allowCard.findByText('org-9')).toBeInTheDocument();
    expect(allowCard.getByText('受限可见：仅白名单组织可安装')).toBeInTheDocument();

    fireEvent.click(allowCard.getByRole('button', { name: '移出白名单' }));
    expect(await screen.findByText('已移出白名单')).toBeInTheDocument();
    const remove = calls.find((c) => c.method === 'DELETE')!;
    expect(remove.url).toBe('/api/v1/extensions/ext-1/allowlist/org-9');
  });

  it('白名单写入被拒（403）：Toast 失败反馈 + 403 Badge 如实呈现', async () => {
    await renderDetail({
      allowlist: ALLOWLIST_EMPTY,
      write: (url) => (url.includes('/allowlist')
        ? jsonResponse({ error: { code: 'FORBIDDEN', message: '无权管理该扩展的白名单' } }, 403)
        : undefined),
    });
    await screen.findByRole('heading', { name: '检索包装' });

    const allowCard = card('组织白名单');
    fireEvent.change(allowCard.getByLabelText('白名单组织'), { target: { value: 'org-2' } });
    fireEvent.click(allowCard.getByRole('button', { name: '加入白名单' }));

    expect(await screen.findByText('加入白名单失败')).toBeInTheDocument();
    expect(screen.getByText('403 FORBIDDEN')).toBeInTheDocument();
  });
});
