import type { ReactElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { jsonResponse, makeQueryClient } from './helpers';

/**
 * Extensions 页面测试夹具（M13-W7）
 *
 * 与后端契约对齐的事实（apps/api/src/modules/extensions）：
 *  - 响应一律是 TransformInterceptor 的 `{ data: … }` 信封；
 *  - list 返回扩展 + versions + installation；catalog 返回 publishedVersion + installation；
 *    installations 返回安装行 + extension + pinnedVersion；steps 返回已启用安装的步骤模板；
 *  - 写路径返回各自 DTO（publish→版本、deprecate/archive→扩展、install→{installation,materialized,permissions}）。
 */

export const INSTALLATION_ID = 'inst-1';

export const ORGS = [
  {
    id: 'org-1', name: '主组织', slug: 'main', isPersonal: false, createdAt: '2026-09-01T00:00:00.000Z',
    members: [{ role: 'owner' }], _count: { members: 2, projects: 1 },
  },
  {
    id: 'org-2', name: '第二组织', slug: 'second', isPersonal: true, createdAt: '2026-09-02T00:00:00.000Z',
    members: [{ role: 'viewer' }], _count: { members: 1, projects: 0 },
  },
];

export function version(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v-1', extensionId: 'ext-1', version: 1,
    manifest: { manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'] },
    checksum: 'a'.repeat(64), signature: null, status: 'draft', createdAt: '2026-09-20T00:00:00.000Z',
    permissions: [{ id: 'p-1', versionId: 'v-1', name: 'tool.execute', scope: 'organization', description: null }],
    ...overrides,
  };
}

export function installation(overrides: Record<string, unknown> = {}) {
  return {
    id: INSTALLATION_ID, organizationId: 'org-1', extensionId: 'ext-1', versionId: 'v-1',
    status: 'enabled', config: {}, installedByUserId: 'u-1',
    installedAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
    extension: null, pinnedVersion: null,
    ...overrides,
  };
}

export function extension(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ext-1', organizationId: 'org-1', ownerUserId: 'u-1', name: '检索包装', slug: 'wrap-search',
    description: '只读检索包装', kind: 'tool', status: 'draft',
    createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    versions: [version()], installation: null,
    ...overrides,
  };
}

export function catalogEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ext-1', name: '检索包装', slug: 'wrap-search', description: '只读检索包装', kind: 'tool',
    scope: 'platform', publishedVersion: version({ status: 'published', signature: 'sig' }), installation: null,
    ...overrides,
  };
}

export function stepTemplate(overrides: Record<string, unknown> = {}) {
  return {
    extensionId: 'ext-1', extensionSlug: 'wrap-search', versionId: 'v-1', version: 1,
    name: 'search_step', stepType: 'tool', description: '检索步骤', params: { toolName: 'knowledge.search' },
    permissions: ['workflow.step'],
    ...overrides,
  };
}

export const ALLOWLIST_EMPTY = { extensionId: 'ext-1', restricted: false, items: [] as Array<{ organizationId: string; createdAt: string }> };

export interface MockRoutes {
  organizations?: unknown;
  extensions?: unknown[];
  catalog?: unknown[];
  installations?: unknown[];
  steps?: unknown[];
  allowlist?: typeof ALLOWLIST_EMPTY;
  /** 覆写任意写请求（含状态码模拟：403/400…） */
  write?: (url: string, init?: RequestInit) => Response | undefined;
  /** 覆写任意读请求（含状态码模拟：403/404…）；返回 undefined 则回落到默认桩 */
  read?: (url: string) => Response | undefined;
}

export interface RecordedCall { url: string; method: string; body: unknown }

/** 记录全部请求；未覆盖的请求直接抛错（防止页面发出未预期调用） */
export function mockExtensionsApi(routes: MockRoutes = {}) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });

    if (method !== 'GET') {
      const custom = routes.write?.(url, init);
      if (custom) return custom;
      if (url.endsWith('/publish')) return jsonResponse({ data: version({ status: 'published', signature: 'sig' }) });
      if (url.endsWith('/deprecate')) return jsonResponse({ data: extension({ status: 'deprecated' }) });
      if (url.endsWith('/archive')) return jsonResponse({ data: extension({ status: 'archived' }) });
      if (url.endsWith('/uninstall')) return jsonResponse({ data: { uninstalled: true, extensionId: 'ext-1', organizationId: 'org-1' } });
      if (url.endsWith('/install')) {
        return jsonResponse({ data: { installation: installation(), materialized: [], permissions: ['tool.execute'] } });
      }
      if (url.endsWith('/enable')) return jsonResponse({ data: installation({ status: 'enabled' }) });
      if (url.endsWith('/disable')) return jsonResponse({ data: installation({ status: 'disabled' }) });
      if (url.includes('/allowlist')) return jsonResponse({ data: { entry: { organizationId: 'org-2' }, disabledOrganizations: [] } });
      if (url === '/api/v1/extensions') return jsonResponse({ data: { extension: extension(), version: version() } }, 201);
      if (/\/api\/v1\/extensions\/[^/?]+$/.test(url)) return jsonResponse({ data: { extension: extension(), version: version() } });
      throw new Error(`未预期的写请求：${method} ${url}`);
    }

    const customRead = routes.read?.(url);
    if (customRead) return customRead;

    if (url.includes('/api/v1/organizations')) return jsonResponse({ data: routes.organizations ?? ORGS });
    if (url.includes('/api/v1/extensions/catalog?')) return jsonResponse({ data: routes.catalog ?? [] });
    if (url.includes('/api/v1/extensions/installations?')) return jsonResponse({ data: routes.installations ?? [] });
    if (url.includes('/api/v1/extensions/steps?')) return jsonResponse({ data: routes.steps ?? [] });
    if (url.includes('/allowlist')) return jsonResponse({ data: routes.allowlist ?? ALLOWLIST_EMPTY });
    if (url.startsWith('/api/v1/extensions?')) return jsonResponse({ data: routes.extensions ?? [] });
    if (/^\/api\/v1\/extensions\/[^/?]+\?/.test(url)) return jsonResponse({ data: routes.extensions?.[0] ?? extension() });
    throw new Error(`未预期的读请求：${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

/** 页面渲染：react-query（页面用 useApiQuery/useApiMutation）+ 全局 Toast 容器（AppShell 在真实运行时提供） */
export function renderExtensionsPage(ui: ReactElement): RenderResult {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}
