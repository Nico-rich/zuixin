/**
 * M9-P6 / M10-P6 Marketplace 归属与权限裁决（**复用组织 RBAC，绝不新增权限位**）。
 *
 * 权限位口径（逐字复用 extensions 模块 = M8-P6 Extension Foundation）：
 * - 读（目录/详情/评审列表）：`agent.read`（extensions.list/catalog/get 同口径）；
 * - 发布者写（建条目/编辑/发布/撤回/修订）：`agent.write`（extensions.install/publish 同口径）；
 * - 评审审核（moderation）与条目驳回：**M10-P6 起为显式治理判定**——role ∈ owner/admin
 *   （`marketplace-moderation.ts` 的 `MODERATION_ROLES`）或平台管理员；**不再**经由 `member.write`
 *   的隐式借用（审计 D7 / M9-02 闭环：旧口径依赖"矩阵中恰好只有 owner/admin 命中该位"，
 *   矩阵一变即静默放宽治理权）。旧位仅作为漂移检测锚（告警不降级，见 auditModerationMatrix）；
 * - 平台级扩展（extension.organizationId = null）的市场上架仅平台管理员（user.role='admin'，
 *   与 extensions.assertCanManage 同口径）；平台管理员的审核权是**市场治理面**的窄口径逃生门
 *   （只覆盖 review moderation / 条目驳回，绝不覆盖条目内容编辑/发布）。
 *
 * 裁决口径（与 M9-P1/M9-P5 同构，deny-by-default）：
 * - 集合级：显式 organizationId → requirePermission（非成员/无权限 → 403）；
 * - 资源级：资源不存在 → 404；非成员 → 404（防枚举，响应零字段泄漏）；成员但权限位不足 → 403；
 * - 公开目录：published 条目对任何已登录用户可见（市场即公开面）；**未发布条目仅发布者组织成员可见**。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../organizations/authorization.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import {
  MODERATION_ROLES, ModerationRole, assertModerationDecision, auditModerationMatrix, decideModeration,
} from './marketplace-moderation';
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
  /** 可执行治理动作（发布者组织 owner/admin，或平台管理员）——与 assertModerationRights 同一判定 */
  canModerate: boolean;
}

@Injectable()
export class MarketplaceAccessService {
  private readonly logger = new Logger('MarketplaceAccess');

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

  /**
   * 治理（moderation）权：**审核/驳回的唯一裁决入口**（M10-P6 显式判定，审计 D7 / M9-02）。
   *
   * 判定一律经 `assertModerationDecision`（`marketplace-moderation.ts`）：role ∈ owner/admin 或平台管理员。
   * **绝不**调用 `auth.authorize(..., 'member.write')`——旧实现借用该权限位，矩阵调整即静默放宽治理权。
   * 防枚举口径不变：非成员 → 404（存在性不泄露）；成员但非治理角色 → 403。
   * 平台管理员优先放行（跨组织治理逃生门；窄口径，不含内容编辑/发布）。
   */
  async assertModerationRights(userId: string, publication: PublicationScopeRow): Promise<'platform' | ModerationRole> {
    const platformAdmin = await this.isPlatformAdmin(userId);
    if (platformAdmin) {
      assertModerationDecision({ role: null, platformAdmin: true }); // 逃生门同样走显式判定（单一事实源）
      this.warnIfMatrixDrifted();
      return 'platform';
    }
    const membership = await this.auth.membership(userId, publication.organizationId);
    if (!membership) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在'); // 防枚举：非成员与不存在不可区分
    assertModerationDecision({ role: membership.role, platformAdmin }); // 非治理角色 → 403
    this.warnIfMatrixDrifted();
    return membership.role as ModerationRole; // 判定通过 ⇒ role ∈ MODERATION_ROLES（见 isModerationRole）
  }

  /** 发布者写权（编辑/发布/撤回/修订）：非成员 → 404，成员无 agent.write → 403 */
  async assertPublicationWrite(userId: string, publication: PublicationScopeRow): Promise<OrganizationRole> {
    const membership = await this.auth.membership(userId, publication.organizationId);
    if (!membership) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在'); // 防枚举
    return this.auth.authorize(userId, publication.organizationId, 'agent.write');
  }

  /**
   * 条目可见性：published → 任何已登录用户；其余状态 → 仅发布者组织成员（非成员 404，防枚举）。
   * 返回调用者的查看能力（供详情页回显；**只读展示**；`canModerate` 与裁决走**同一显式判定**，
   * 绝不出现"回显可审核但实际 403"或反之的口径分叉）。
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
      // 治理能力 = 显式判定（role ∈ owner/admin ∨ 平台管理员），**不**经 member.write 反推
      canModerate: decideModeration({ role, platformAdmin }).allowed,
    };
  }

  /**
   * 矩阵漂移检测（**告警不降级**）：治理判定已与权限矩阵解耦，漂移不改变任何裁决结果，
   * 仅把"旧借用口径会放宽治理权"的事实暴露给运维/审计（矩阵改动由单测强制人工复核）。
   */
  private warnIfMatrixDrifted(): void {
    const audit = auditModerationMatrix((role, action) => this.auth.can(role, action));
    if (audit.consistent) return;
    this.logger.warn(
      `marketplace moderation 权限矩阵漂移：${audit.permission} leaked=[${audit.leakedRoles.join(',')}] `
      + `missing=[${audit.missingRoles.join(',')}]——治理判定恒为 ${MODERATION_ROLES.join('/')}（已与矩阵解耦，不放宽）`,
    );
  }
}
