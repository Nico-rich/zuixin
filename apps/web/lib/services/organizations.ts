import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Organizations / Team service（M13-F1）
 * 后端：apps/api/src/modules/organizations/organizations.controller.ts
 * （两个控制器：`organizations` 带 OrgStatusGuard；`invitations` 只需 JwtAuthGuard）
 *
 * 红线：角色（owner/admin/member/viewer）由服务端 RBAC 裁决；前端只按返回的 role **显隐**入口，
 * 绝不能把它当作授权（所有写路径服务端都会再判一次）。
 */
export type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  isPersonal: boolean;
  createdAt: string;
  members: Array<{ role: OrganizationRole }>;
  _count: { members: number; projects: number };
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  isPersonal: boolean;
  ownerUserId: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  joinedAt: string;
  createdAt: string;
  updatedAt: string;
  user?: { id: string; email: string; displayName: string | null };
}

export interface OrganizationInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  invitedByUserId: string;
  token: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  acceptedByUserId: string | null;
  createdAt: string;
}

export const organizationKeys = {
  all: ['organizations'] as const,
  detail: (id: string) => ['organization', id] as const,
  members: (id: string) => ['organization-members', id] as const,
  invitations: (id: string) => ['organization-invitations', id] as const,
};

/** GET /api/v1/organizations（含个人组织） */
export const listOrganizations = () => apiFetch<{ data: OrganizationSummary[] }>('/api/v1/organizations');

/** POST /api/v1/organizations */
export const createOrganization = (input: { name: string; slug?: string }) =>
  apiFetch<{ data: Organization & { members: Array<{ userId: string; role: OrganizationRole }> } }>(
    '/api/v1/organizations', jsonInit('POST', input),
  );

/** GET /api/v1/organizations/:id */
export const getOrganization = (id: string) =>
  apiFetch<{ data: Organization & { members: Array<{ userId: string; role: OrganizationRole; joinedAt: string }> } }>(
    `/api/v1/organizations/${id}`,
  );

/** PATCH /api/v1/organizations/:id */
export const updateOrganization = (id: string, input: { name?: string }) =>
  apiFetch<{ data: Organization }>(`/api/v1/organizations/${id}`, jsonInit('PATCH', input));

/** DELETE /api/v1/organizations/:id */
export const deleteOrganization = (id: string) =>
  apiFetch<{ data: { deleted: true } }>(`/api/v1/organizations/${id}`, { method: 'DELETE' });

/** POST /api/v1/organizations/:id/disable */
export const disableOrganization = (id: string) =>
  apiFetch<{ data: { id: string; status: 'disabled'; unchanged: boolean } }>(`/api/v1/organizations/${id}/disable`, jsonInit('POST'));

/** POST /api/v1/organizations/:id/enable */
export const enableOrganization = (id: string) =>
  apiFetch<{ data: { id: string; status: 'active'; unchanged: boolean } }>(`/api/v1/organizations/${id}/enable`, jsonInit('POST'));

/** GET /api/v1/organizations/:id/members */
export const listMembers = (id: string) => apiFetch<{ data: OrganizationMember[] }>(`/api/v1/organizations/${id}/members`);

/** DELETE /api/v1/organizations/:id/members/:userId */
export const removeMember = (id: string, userId: string) =>
  apiFetch<{ data: { removed: true } }>(`/api/v1/organizations/${id}/members/${userId}`, { method: 'DELETE' });

/** POST /api/v1/organizations/:id/invitations（返回一次性 token） */
export const inviteMember = (id: string, input: { email: string; role?: OrganizationRole }) =>
  apiFetch<{ data: { invitationId: string; token: string; email: string; role: OrganizationRole; expiresAt: string } }>(
    `/api/v1/organizations/${id}/invitations`, jsonInit('POST', input),
  );

/** GET /api/v1/organizations/:id/invitations */
export const listInvitations = (id: string) =>
  apiFetch<{ data: OrganizationInvitation[] }>(`/api/v1/organizations/${id}/invitations`);

/** POST /api/v1/invitations/:token/accept */
export const acceptInvitation = (token: string) =>
  apiFetch<{ data: { organizationId: string; role: OrganizationRole } }>(
    `/api/v1/invitations/${encodeURIComponent(token)}/accept`, jsonInit('POST'),
  );

/** POST /api/v1/invitations/:token/revoke */
export const revokeInvitation = (token: string) =>
  apiFetch<{ data: { revoked: true } }>(`/api/v1/invitations/${encodeURIComponent(token)}/revoke`, jsonInit('POST'));
