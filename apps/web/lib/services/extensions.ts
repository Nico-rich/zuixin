import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Extensions service（M13-F1）
 * 后端：apps/api/src/modules/extensions/extensions.controller.ts（JwtAuthGuard + OrgStatusGuard）
 *
 * **组织上下文必填**：除 `GET /:id/allowlist` 外，`organizationId` 都是 required
 * （查询参数或请求体），缺失会被服务端判 VALIDATION_ERROR。
 * 权限披露（permissions / materialized）是**展示投影**，绝不代表授权：授权 = manifest 声明 ∩ 平台白名单 ∩
 * 组织策略，由服务端裁定。
 */
export type ExtensionKind = 'tool' | 'agent' | 'provider' | 'workflow_step';
export type ExtensionScope = 'platform' | 'organization';

export interface ExtensionPermission { id: string; versionId: string; name: string; scope: string; description: string | null }

export interface ExtensionVersion {
  id: string;
  extensionId: string;
  version: number;
  manifest: unknown;
  checksum: string;
  signature: string | null;
  status: string;
  createdAt: string;
  permissions?: ExtensionPermission[];
}

export interface Extension {
  id: string;
  organizationId: string | null;
  ownerUserId: string;
  name: string;
  slug: string;
  description: string | null;
  kind: ExtensionKind | string;
  status: 'draft' | 'published' | 'deprecated' | 'archived' | string;
  createdAt: string;
  updatedAt: string;
  versions?: ExtensionVersion[];
  installation?: ExtensionInstallation | null;
}

export interface ExtensionInstallation {
  id: string;
  organizationId: string;
  extensionId: string;
  versionId: string;
  status: 'enabled' | 'disabled' | string;
  config: unknown;
  installedByUserId: string;
  installedAt: string;
  updatedAt: string;
  extension?: Extension | null;
  pinnedVersion?: ExtensionVersion | null;
}

export interface CatalogEntry {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  kind: ExtensionKind | string;
  scope: ExtensionScope;
  publishedVersion: ExtensionVersion | null;
  installation: ExtensionInstallation | null;
}

export interface ExtensionStep {
  extensionId: string;
  extensionSlug: string;
  versionId: string;
  version: number;
  name: string;
  stepType: string;
  description: string | null;
  params: unknown;
  permissions: unknown;
}

export interface CreateExtensionInput {
  name: string;
  slug: string;
  kind: ExtensionKind;
  manifest: unknown;
  organizationId?: string | null;
  description?: string;
}

export const extensionKeys = {
  all: (organizationId: string) => ['extensions', organizationId] as const,
  catalog: (organizationId: string) => ['extensions-catalog', organizationId] as const,
  installations: (organizationId: string) => ['extensions-installations', organizationId] as const,
  steps: (organizationId: string) => ['extensions-steps', organizationId] as const,
  detail: (id: string, organizationId: string) => ['extension', id, organizationId] as const,
  allowlist: (id: string) => ['extension-allowlist', id] as const,
};

/** POST /api/v1/extensions（创建扩展 + 首版草稿） */
export const createExtension = (input: CreateExtensionInput) =>
  apiFetch<{ data: { extension: Extension; version: ExtensionVersion } }>('/api/v1/extensions', jsonInit('POST', input));

/** GET /api/v1/extensions?organizationId=（组织内扩展，含版本与安装态） */
export const listExtensions = (organizationId: string) =>
  apiFetch<{ data: Extension[] }>(`/api/v1/extensions?organizationId=${encodeURIComponent(organizationId)}`);

/** GET /api/v1/extensions/catalog?organizationId=（平台级 + 组织私有，含安装态） */
export const listCatalog = (organizationId: string) =>
  apiFetch<{ data: CatalogEntry[] }>(`/api/v1/extensions/catalog?organizationId=${encodeURIComponent(organizationId)}`);

/** GET /api/v1/extensions/installations?organizationId= */
export const listInstallations = (organizationId: string) =>
  apiFetch<{ data: ExtensionInstallation[] }>(`/api/v1/extensions/installations?organizationId=${encodeURIComponent(organizationId)}`);

/** GET /api/v1/extensions/steps?organizationId=（可作为工作流步骤的扩展面） */
export const listExtensionSteps = (organizationId: string) =>
  apiFetch<{ data: ExtensionStep[] }>(`/api/v1/extensions/steps?organizationId=${encodeURIComponent(organizationId)}`);

/** GET /api/v1/extensions/:id?organizationId= */
export const getExtension = (id: string, organizationId: string) =>
  apiFetch<{ data: Extension }>(`/api/v1/extensions/${id}?organizationId=${encodeURIComponent(organizationId)}`);

/** PATCH /api/v1/extensions/:id（改名/描述/manifest → 新草稿版本） */
export const updateExtension = (id: string, input: { name?: string; description?: string; manifest?: unknown }) =>
  apiFetch<{ data: { extension: Extension; version: ExtensionVersion | null } }>(`/api/v1/extensions/${id}`, jsonInit('PATCH', input));

/** POST /api/v1/extensions/:id/publish */
export const publishExtension = (id: string, input: { versionId?: string } = {}) =>
  apiFetch<{ data: ExtensionVersion }>(`/api/v1/extensions/${id}/publish`, jsonInit('POST', input));

/** POST /api/v1/extensions/:id/deprecate */
export const deprecateExtension = (id: string) =>
  apiFetch<{ data: Extension }>(`/api/v1/extensions/${id}/deprecate`, jsonInit('POST'));

/** POST /api/v1/extensions/:id/archive */
export const archiveExtension = (id: string) =>
  apiFetch<{ data: Extension }>(`/api/v1/extensions/${id}/archive`, jsonInit('POST'));

/** POST /api/v1/extensions/:id/install（返回物化结果与生效权限） */
export const installExtension = (id: string, input: { organizationId: string; versionId?: string; config?: Record<string, unknown> }) =>
  apiFetch<{ data: { installation: ExtensionInstallation; materialized: unknown; permissions: unknown } }>(
    `/api/v1/extensions/${id}/install`, jsonInit('POST', input),
  );

/** POST /api/v1/extensions/:id/uninstall */
export const uninstallExtension = (id: string, organizationId: string) =>
  apiFetch<{ data: { uninstalled: true; extensionId: string; organizationId: string } }>(
    `/api/v1/extensions/${id}/uninstall`, jsonInit('POST', { organizationId }),
  );

/** POST /api/v1/extensions/:id/enable */
export const enableExtension = (id: string, organizationId: string) =>
  apiFetch<{ data: ExtensionInstallation }>(`/api/v1/extensions/${id}/enable`, jsonInit('POST', { organizationId }));

/** POST /api/v1/extensions/:id/disable */
export const disableExtension = (id: string, organizationId: string) =>
  apiFetch<{ data: ExtensionInstallation }>(`/api/v1/extensions/${id}/disable`, jsonInit('POST', { organizationId }));

/** GET /api/v1/extensions/:id/allowlist（受限可见性白名单） */
export const getAllowlist = (id: string) =>
  apiFetch<{ data: { extensionId: string; restricted: boolean; items: Array<{ organizationId: string; createdAt: string }> } }>(
    `/api/v1/extensions/${id}/allowlist`,
  );

/** POST /api/v1/extensions/:id/allowlist */
export const addToAllowlist = (id: string, organizationId: string) =>
  apiFetch<{ data: { entry: unknown; disabledOrganizations: string[] } }>(
    `/api/v1/extensions/${id}/allowlist`, jsonInit('POST', { organizationId }),
  );

/** DELETE /api/v1/extensions/:id/allowlist/:organizationId */
export const removeFromAllowlist = (id: string, organizationId: string) =>
  apiFetch<{ data: { removed: true; extensionId: string; organizationId: string } }>(
    `/api/v1/extensions/${id}/allowlist/${organizationId}`, { method: 'DELETE' },
  );
