import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Projects service（M13-F1）
 * 后端：apps/api/src/modules/projects/projects.controller.ts（JwtAuthGuard；全部 `{ data }` 信封）
 */
export interface Project {
  id: string;
  name: string;
  description: string | null;
  metadata?: unknown;
  organizationId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  organizationId?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

export const projectKeys = {
  all: ['projects'] as const,
  detail: (id: string) => ['projects', id] as const,
};

/** GET /api/v1/projects（无分页，服务端 take 50） */
export const listProjects = () => apiFetch<{ data: Project[] }>('/api/v1/projects');

/** POST /api/v1/projects */
export const createProject = (input: CreateProjectInput) =>
  apiFetch<{ data: Project }>('/api/v1/projects', jsonInit('POST', input));

/** GET /api/v1/projects/:id */
export const getProject = (id: string) => apiFetch<{ data: Project }>(`/api/v1/projects/${id}`);

/** PATCH /api/v1/projects/:id */
export const updateProject = (id: string, input: UpdateProjectInput) =>
  apiFetch<{ data: Project }>(`/api/v1/projects/${id}`, jsonInit('PATCH', input));

/** DELETE /api/v1/projects/:id（软删；响应体为空对象） */
export const deleteProject = (id: string) => apiFetch<{ data?: unknown }>(`/api/v1/projects/${id}`, { method: 'DELETE' });
