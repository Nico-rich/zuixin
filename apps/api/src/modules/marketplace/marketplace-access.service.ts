/**
 * M9-P6 Marketplace 归属与权限裁决（**复用组织 RBAC，绝不新增权限位**）。
 *
 * 权限位口径（逐字复用 extensions 模块 = M8-P6 Extension Foundation）：
 * - 读（目录/详情/评审列表）：`agent.read`（extensions.list/catalog/get 同口径）；
 * - 发布者写（建条目/编辑/发布/撤回/修订）：`agent.write`（extensions.install/publish 同口径）；
 * - 评审审核（moderation）：`member.write`——本矩阵中**恰好**只有 owner/admin 命中
 *   （member 仅 member.read，viewer 无 member.*），即"治理动作仅组织 owner/admin"，**不新增权限位**；
 * - 平台级扩展（extension.organizationId = null）的市场上架仅平台管理员（user.role='admin'，
 *   与 extensions.assertCanManage 同口径）；平台管理员的审核权是**市场治理面**的窄口径逃生门
 *   （只覆盖 review moderation，绝不覆盖条目内容编辑/发布）。
 *
 * 裁决口径（与 M9-P1/M9-P5 同构，deny-by-default）：
 * - 集合级：显式 organizationId → requirePermission（非成员/无权限 → 403）；
 * - 资源级：资源不存在 → 404；非成员 → 404（防枚举，响应零字段泄漏）；成员但权限位不足 → 403；
 * - 公开目录：published 条目对任何已登录用户可见（市场即公开面）；**未发布条目仅发布者组织成员可见**。
 */

import { Inject, Injectable } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../organizations/authorization.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { PublicationStatus, isPubliclyVisible } from './marketplace-status';

/** 条目可见性判定所需的最小行（避免 access 层依赖 Prisma 生成类型，单测可注入纯对象） */
export interface PublicationScopeRow {
  organizationId: string;
  userId: string;
  extensionId: string;
  status: string;
}

export interface ViewerCapabilities {
  /** 调用者在发布者组织中的角色（非成员 → null） */
  role: OrganizationRole | null;
  /** 平台管理员（user.role='admin'） */
  platformAdmin: boolean;
  /** 可管理条目内容（发布者组织 agent.write） */
  canManage: boolean;
  /** 可审核评审（发布者组织 owner/admin，或平台管理员） */
  canModerate: boolean;
}

@Injectable()
export class MarketplaceAccessService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthorizationService) private readonly auth: AuthorizationService,
  ) {}

  /** 平台管理员判定（与 extensions.assertCanManage 同口径） */
  async isPlatformAdmin(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role === 'admin';
  }

  /** 集合级读（目录检索：published 公开；非 published 需 organizationId） */
  async requireRead(userId: string, organizationId: string): Promise<OrganizationRole> {
    return this.auth.authorize(userId, organizationId, 'agent.read');
  }

  /** 集合级写（建条目） */
  async requireWrite(userId: string, organizationId: string): Promise<OrganizationRole> {
    return this.auth.authorize(userId, organizationId, 'agent.write');
  }

  /** 评审审核权（owner/admin 或平台管理员）；非成员 → 404；成员但非 owner/admin → 403 */
  async assertModerationRights(userId: string, publication: PublicationScopeRow): Promise<'platform' | OrganizationRole> {
    if (await this.isPlatformAdmin(userId)) return 'platform';
    const membership = await this.auth.membership(userId, publication.organizationId);
    if (!membership) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在'); // 防枚举
    return this.auth.authorize(userId, publication.organizationId, 'member.write');
  }

  /** 发布者写权（编辑/发布/撤回/修订）：非成员 → 404，成员无 agent.write → 403 */
  async assertPublicationWrite(userId: string, publication: PublicationScopeRow): Promise<OrganizationRole> {
    const membership = await this.auth.membership(userId, publication.organizationId);
    if (!membership) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在'); // 防枚举
    return this.auth.authorize(userId, publication.organizationId, 'agent.write');
  }

  /**
   * 条目可见性：published → 任何已登录用户；其余状态 → 仅发布者组织成员（非成员 404，防枚举）。
   * 返回调用者的查看能力（供详情页回显；**只读展示**，不参与任何授权判定）。
   */
  async assertVisible(userId: string, publication: PublicationScopeRow): Promise<ViewerCapabilities> {
    const platformAdmin = await this.isPlatformAdmin(userId);
    const membership = await this.auth.membership(userId, publication.organizationId);
    if (!isPubliclyVisible(publication.status as PublicationStatus) && !membership && !platformAdmin) {
      throw new AppError(ErrorCode.NOT_FOUND, '资源不存在'); // 未发布条目跨组织 404 防枚举
    }
    const role = membership?.role ?? null;
    return {
      role,
      platformAdmin,
      canManage: role ? this.auth.can(role, 'agent.write') : false,
      canModerate: platformAdmin || (role ? this.auth.can(role, 'member.write') : false),
    };
  }
}
