import { Inject, Injectable } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { orgDisabledError } from '../../common/guards/org-status.guard';

export type OrgPermission =
  | 'organization.read' | 'organization.write'
  | 'member.read' | 'member.write'
  | 'project.read' | 'project.write'
  | 'agent.read' | 'agent.write'
  | 'workflow.read' | 'workflow.write'
  | 'connection.read' | 'connection.write'
  | 'billing.read' | 'billing.write'
  // M9-P1：Evaluation / Experimentation（写 = owner/admin；读 = 全部成员）
  | 'evaluation.read' | 'evaluation.write'
  // M11-P12：Marketplace **专用治理位**（审核评审 / 驳回条目；owner/admin = 有、member/viewer = 无）。
  // 读面仍走 agent.read、发布者写面仍走 agent.write —— 本位置只覆盖治理动作，绝不覆盖内容编辑/发布。
  | 'marketplace.moderate';

const ALL: OrgPermission[] = [
  'organization.read', 'organization.write', 'member.read', 'member.write',
  'project.read', 'project.write', 'agent.read', 'agent.write',
  'workflow.read', 'workflow.write', 'connection.read', 'connection.write',
  'billing.read', 'billing.write',
  'evaluation.read', 'evaluation.write',
  'marketplace.moderate',
];

/** M8-P1 RBAC 矩阵（deny-by-default：未列出的权限一律拒绝） */
const ROLE_PERMISSIONS: Record<OrganizationRole, OrgPermission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== 'organization.write' && p !== 'billing.write'),
  member: [
    'organization.read', 'member.read',
    'project.read', 'project.write',
    'agent.read', 'agent.write',
    'workflow.read', 'workflow.write',
    'connection.read', 'connection.write',
    'billing.read',
    'evaluation.read',
  ],
  viewer: ['organization.read', 'project.read', 'agent.read', 'workflow.read', 'connection.read', 'evaluation.read'],
};

/**
 * 权限矩阵**纯查询**（无 IO、无实例状态）——矩阵的唯一读取入口。
 *
 * M11-P12 起被两处共用（**单一事实源**，不得各自复制矩阵）：
 * - 本服务的 `can` / `authorize`（组织 RBAC）；
 * - `marketplace/marketplace-moderation.ts` 的治理判定（`marketplace.moderate` 位 = 治理权的唯一口径；
 *   该模块的 `MODERATION_ROLES` 仅作矩阵审计对照，不再单独决定放行）。
 *
 * fail-closed：未知角色字面量（Prisma 枚举未来新增而矩阵未显式归类）→ `false`，
 * 既不抛出也不放行（deny-by-default 不因"查不到"被绕过；由 `authorize` 统一转 403）。
 */
export function roleHasPermission(role: OrganizationRole, action: OrgPermission): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(action);
}

/**
 * M8-P1 统一授权（服务端最终决定权限；deny-by-default）：
 * - membership：组织未删除 + 成员行（角色）+ 组织治理态（M10-P14）；非成员 → null；
 * - require：非成员/组织不存在 → 403 FORBIDDEN（不泄露组织存在性之外的信息）；
 *   组织禁用（`Organization.status=disabled`）→ 403 ORG_DISABLED（M10-P14：服务层纵深，
 *   覆盖全部走组织 RBAC 的服务路径——HTTP 面另由 OrgStatusGuard 在控制器挂载点判定）；
 * - authorize(user, organizationId, action)：角色权限矩阵裁决。
 * 资源读路径绝不信客户端 organizationId——从资源行取 orgId 再校验（防 IDOR）。
 */
@Injectable()
export class AuthorizationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async membership(userId: string, organizationId: string): Promise<{ role: OrganizationRole; orgStatus?: string } | null> {
    const org = await this.prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!org) return null;
    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true },
    });
    return member ? { role: member.role, orgStatus: org.status } : null;
  }

  async require(userId: string, organizationId: string): Promise<OrganizationRole> {
    const m = await this.membership(userId, organizationId);
    if (!m) throw new AppError(ErrorCode.FORBIDDEN, '无权访问该组织');
    // M10-P14 X-21：组织被禁用 → 一切组织级访问/管理拒绝（含 owner；平台管理员不经由本方法，见各管理端点）
    if (m.orgStatus === 'disabled') throw orgDisabledError('组织已被禁用，无法访问其资源');
    return m.role;
  }

  async authorize(userId: string, organizationId: string, action: OrgPermission): Promise<OrganizationRole> {
    const role = await this.require(userId, organizationId);
    if (!roleHasPermission(role, action)) throw new AppError(ErrorCode.FORBIDDEN, '权限不足');
    return role;
  }

  /** 纯查询（无 IO）：委托 `roleHasPermission`（矩阵唯一读取入口，未知角色 → false） */
  can(role: OrganizationRole, action: OrgPermission): boolean {
    return roleHasPermission(role, action);
  }
}
