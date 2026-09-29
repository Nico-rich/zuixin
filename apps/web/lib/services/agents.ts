import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Agents service（M13-F1）
 * 后端：apps/api/src/modules/agents-admin/agents-admin.controller.ts
 *
 * 注意：**全控制器带 `@Roles('admin')`**（JwtAuthGuard + RolesGuard）——非管理员调用会收到 403 FORBIDDEN。
 * 页面必须把 403 呈现为「需要管理员权限」，不得假装成功（服务端才是裁决方，前端不做权限判定）。
 */
export interface Agent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  priority: number;
  builtin: boolean;
  kind: 'builtin' | 'custom' | string;
  scope: 'system' | 'organization' | 'user' | string;
  organizationId: string | null;
  activeVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  versions?: AgentVersion[];
  activeVersion?: AgentVersion | null;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  version: number;
  status: 'draft' | 'published' | 'archived' | string;
  systemPrompt: string;
  modelId: string | null;
  tools: unknown;
  temperature: number;
  maxTokens: number | null;
  config: unknown;
  createdAt: string;
  createdBy: string | null;
}

export interface CreateAgentInput {
  slug: string;
  name: string;
  description?: string;
  kind: string;
  systemPrompt: string;
  tools?: string[];
  modelId?: string | null;
  temperature?: number;
  maxTokens?: number | null;
  config?: Record<string, unknown>;
}

export interface UpdateAgentDraftInput {
  systemPrompt?: string;
  tools?: string[];
  modelId?: string | null;
  temperature?: number;
  maxTokens?: number | null;
  config?: Record<string, unknown>;
}

export const agentKeys = {
  all: ['agents'] as const,
  detail: (id: string) => ['agents', id] as const,
  versions: (id: string) => ['agents', id, 'versions'] as const,
};

/** GET /api/v1/agents（仅 admin；裸数组，无分页） */
export const listAgents = () => apiFetch<{ data: Agent[] }>('/api/v1/agents');

/** GET /api/v1/agents/:id */
export const getAgent = (id: string) => apiFetch<{ data: Agent }>(`/api/v1/agents/${id}`);

/**
 * GET /api/v1/agents/:id/versions
 * 事实源说明：后端 handler 与 GET /agents/:id 返回同一 payload（版本随 Agent 行返回）
 */
export const getAgentVersions = (id: string) => apiFetch<{ data: Agent }>(`/api/v1/agents/${id}/versions`);

/** POST /api/v1/agents（仅 admin） */
export const createAgent = (input: CreateAgentInput) => apiFetch<{ data: Agent }>('/api/v1/agents', jsonInit('POST', input));

/** PATCH /api/v1/agents/:id/draft（落草稿版本） */
export const updateAgentDraft = (id: string, input: UpdateAgentDraftInput) =>
  apiFetch<{ data: AgentVersion }>(`/api/v1/agents/${id}/draft`, jsonInit('PATCH', input));

/** POST /api/v1/agents/:id/publish（草稿 → 发布） */
export const publishAgent = (id: string) => apiFetch<{ data: Agent }>(`/api/v1/agents/${id}/publish`, jsonInit('POST'));

/** POST /api/v1/agents/:id/rollback（回滚到指定版本） */
export const rollbackAgent = (id: string, versionId: string) =>
  apiFetch<{ data: Agent }>(`/api/v1/agents/${id}/rollback`, jsonInit('POST', { versionId }));

/** PATCH /api/v1/agents/:id/enabled（启用/停用） */
export const setAgentEnabled = (id: string, enabled: boolean) =>
  apiFetch<{ data: Agent }>(`/api/v1/agents/${id}/enabled`, jsonInit('PATCH', { enabled }));
