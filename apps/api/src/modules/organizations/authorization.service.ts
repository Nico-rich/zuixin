import { Inject, Injectable } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

export type OrgPermission =
  | 'organization.read' | 'organization.write'
  | 'member.read' | 'member.write'
  | 'project.read' | 'project.write'
  | 'agent.read' | 'agent.write'
  | 'workflow.read' | 'workflow.write'
  | 'connection.read' | 'connection.write'
  | 'billing.read' | 'billing.write'
  // M9-P1：Evaluation / Experimentation（写 = owner/admin；读 = 全部成员）
  | 'evaluation.read' | 'evaluation.write';

const ALL: OrgPermission[] = [
  'organization.read', 'organization.write', 'member.read', 'member.write',
  'project.read', 'project.write', 'agent.read', 'agent.write',
  'workflow.read', 'workflow.write', 'connection.read', 'connection.write',
  'billing.read', 'billing.write',
  'evaluation.read', 'evaluation.write',
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
 * M8-P1 统一授权（服务端最终决定权限；deny-by-default）：
 * - membership：组织未删除 + 成员行（角色）；非成员 → null；
 * - require：非成员/组织不存在 → 403 FORBIDDEN（不泄露组织存在性之外的信息）；
 * - authorize(user, organizationId, action)：角色权限矩阵裁决。
 * 资源读路径绝不信客户端 organizationId——从资源行取 orgId 再校验（防 IDOR）。
 */
@Injectable()
export class AuthorizationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async membership(userId: string, organizationId: string): Promise<{ role: OrganizationRole } | null> {
    const org = await this.prisma.organization.findFirst({ where: { id: organizationId, deletedAt: null }, select: { id: true } });
    if (!org) return null;
    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true },
    });
    return member ? { role: member.role } : null;
  }

  async require(userId: string, organizationId: string): Promise<OrganizationRole> {
    const m = await this.membership(userId, organizationId);
    if (!m) throw new AppError(ErrorCode.FORBIDDEN, '无权访问该组织');
    return m.role;
  }

  async authorize(userId: string, organizationId: string, action: OrgPermission): Promise<OrganizationRole> {
    const role = await this.require(userId, organizationId);
    if (!ROLE_PERMISSIONS[role].includes(action)) throw new AppError(ErrorCode.FORBIDDEN, '权限不足');
    return role;
  }

  can(role: OrganizationRole, action: OrgPermission): boolean {
    return ROLE_PERMISSIONS[role].includes(action);
  }
}
