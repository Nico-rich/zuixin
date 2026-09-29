import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Providers service（M13+ 模型配置页）
 *
 * 后端为**平台管理员面**（DB 权威 role='admin'；非管理员 403）。
 * 红线对齐：
 * - apiKey **只写**：服务端从不回显任何形式的 Key——前端只有 `hasKey` 布尔；
 *   编辑框提交空串 = 不修改（PATCH body 不含 apiKey 键）。
 * - 前端不做权限裁决（导航入口可见性只是体验；403 由服务端权威返回并在页面呈现）。
 */
export interface ProviderModelView {
  id: string;
  name: string;
  apiModelId: string;
  type: string;
  enabled: boolean;
  priority: number;
  isDefault: boolean;
  contextWindow: number | null;
  inputPrice: number;
  outputPrice: number;
  unitPrice: number;
  capabilities: unknown;
}

export interface ProviderView {
  id: string;
  name: string;
  type: string;
  adapter: string;
  baseUrl: string;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  /** 服务端是否已配置 Key（只回布尔，**绝无 Key 回显**） */
  hasKey: boolean;
  keyVersion: number | null;
  healthStatus: string;
  /** 内存 adapter 是否已建（false = 已停用或加载失败） */
  loaded: boolean;
  degradedReason: string | null;
  managedByExtension: boolean;
  models: ProviderModelView[];
  createdAt: string;
  updatedAt: string;
}

/** PATCH 可写面（与后端 ProviderPatchSchema 同构；空串 apiKey = 不改，由页面过滤掉） */
export interface ProviderPatch {
  apiKey?: string;
  enabled?: boolean;
  priority?: number;
  baseUrl?: string;
  timeoutMs?: number;
}

export const providerKeys = {
  list: ['providers'] as const,
};

/** GET /api/v1/providers（平台管理员；投影视图，无 Key 回显） */
export const listProviders = () => apiFetch<{ data: { providers: ProviderView[] } }>('/api/v1/providers');

/** PATCH /api/v1/providers/:id（apiKey 只写/enabled/priority/baseUrl/timeoutMs；写后服务端热刷新） */
export const updateProvider = (id: string, patch: ProviderPatch) =>
  apiFetch<{ data: ProviderView }>(`/api/v1/providers/${encodeURIComponent(id)}`, jsonInit('PATCH', patch));
