/**
 * M9-P6 / M10-P6 / M11-P12 Marketplace 归属与权限裁决（**复用组织 RBAC 唯一矩阵**）。
 *
 * 权限位口径（逐字复用 extensions 模块 = M8-P6 Extension Foundation；读/写面不新增位）：
 * - 读（目录/详情/评审列表）：`agent.read`（extensions.list/catalog/get 同口径）；
 * - 发布者写（建条目/编辑/发布/撤回/修订）：`agent.write`（extensions.install/publish 同口径）；
 * - 评审审核（moderation）与条目驳回：**M11-P12 专用治理位 `marketplace.moderate`**
 *   （owner/admin = 有、member/viewer = 无，见 `organizations/authorization.service.ts` 矩阵）
 *   或平台管理员。演进：M9-P6 借用 `member.write`（隐式推论）→ M10-P6 显式角色枚举
 *   （与矩阵解耦）→ **M11-P12 专用位（Deferred 落地）**：治理权 = 持有该位，判定与矩阵审计同源
 *   （`marketplace-moderation.ts` 的 `decideModeration` / `auditModerationMatrix`）；
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
import { orgDisabledError } from '../../common/guards/org-status.guard';
import {
  MODERATION_ROLES, RolePermissionLookup,
  assertModerationDecision, auditModerationMatrix, decideModeration,
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
   * 治理（moderation）权：**审核/驳回的唯一裁决入口**（M11-P12 专用治理位 `marketplace.moderate`）。
   *
   * 判定一律经 `assertModerationDecision`（`marketplace-moderation.ts`）：持有治理位或平台管理员。
   * **绝不**调用 `auth.authorize(..., 'member.write')`——M9-P6 借用该位，矩阵调整即静默改变治理面；
   * 专用位把治理权变成一个可审计、可单测锁定的授权事实（矩阵漂移由审计告警 + 单测变红暴露）。
   * 防枚举口径不变：非成员 → 404（存在性不泄露）；成员但未持有治理位 → 403。
   * 平台管理员优先放行（跨组织治理逃生门；窄口径，不含内容编辑/发布）。
   *
   * M10-P15（BUG-13）：`notFoundMessage` 同 `assertPublicationWrite` —— 非成员 404 必须复用调用方
   * "行不存在"的文案，否则文案差异可当存在性 oracle 用（跨租户枚举发布条目 id）。
   */
  async assertModerationRights(
    userId: string, publication: PublicationScopeRow, notFoundMessage = '资源不存在',
  ): Promise<'platform' | OrganizationRole> {
    const lookup = this.roleLookup();
    const platformAdmin = await this.isPlatformAdmin(userId);
    if (platformAdmin) {
      assertModerationDecision({ role: null, platformAdmin: true }, lookup); // 逃生门同样走同一判定（单一事实源）
      this.warnIfMatrixDrifted();
      return 'platform';
    }
    const membership = await this.auth.membership(userId, publication.organizationId);
    if (!membership) throw new AppError(ErrorCode.NOT_FOUND, notFoundMessage); // 防枚举：非成员与不存在不可区分
    // M10-P15（X-21 冻结一致性）：治理动作 = 组织级管理操作，禁用组织一律拒绝。
    // 本路径不经 `auth.authorize`（治理判定走治理位查询），故必须**自行**校验治理态——
    // 否则禁用组织的 owner/admin 仍可驳回条目/审核评审，冻结只挡住内容编辑（authorize 路径）而挡住治理（本路径）。
    this.assertOrgActive(membership.orgStatus);
    // 观测面先于裁决：**拒绝路径同样暴露漂移**（missing 漂移下治理角色恒被拒，若只在放行后告警，
    // "治理面被收紧"这一最需要可见的漂移反而永远不告警）。
    this.warnIfMatrixDrifted();
    assertModerationDecision({ role: membership.role, platformAdmin }, lookup); // 未持有治理位 → 403
    // 放行 = 持有 `marketplace.moderate`；正常矩阵下即 owner/admin（声明治理角色，由审计锁定），
    // 漂移时可能是任何被显式授予该位的角色 —— 如实回传组织角色，不做类型级断言。
    return membership.role;
  }

  /**
   * 治理判定/漂移审计**共用**的矩阵查询器（同源：判定与告警必须读同一事实源，否则两者分叉）。
   * 生产 = 注入的 `AuthorizationService.can`（矩阵唯一读取入口 `roleHasPermission`）。
   */
  private roleLookup(): RolePermissionLookup {
    return (role, action) => this.auth.can(role, action);
  }

  /**
   * 组织治理态校验（M10-P15）：与 `AuthorizationService.require` 同一语义与同一错误码
   * （403 `ORG_DISABLED`），供不经 `authorize` 的判定点复用（治理/可见性路径）。
   */
  private assertOrgActive(orgStatus: string | undefined): void {
    if (orgStatus === 'disabled') throw orgDisabledError('组织已被禁用，无法访问其资源');
  }

  /**
   * 发布者写权（编辑/发布/撤回/修订）：非成员 → 404，成员无 agent.write → 403。
   *
   * M10-P15（BUG-13）：`notFoundMessage` 由调用方传入**该资源**的"不存在"文案。
   * 调用方先按 id 取行（取不到 → 404「<资源>不存在」），再进本方法判成员身份；
   * 若两处文案不同，则"行不存在"与"行存在但非成员"可被**错误文案逐字区分**——
   * 跨租户攻击者据此即可枚举 id 是否存在（存在性 oracle，与 404 折叠语义背道而驰）。
   * 故本方法必须复用调用方的文案：两条 404 路径响应体逐字节一致。
   */
  async assertPublicationWrite(
    userId: string, publication: PublicationScopeRow, notFoundMessage = '资源不存在',
  ): Promise<OrganizationRole> {
    const membership = await this.auth.membership(userId, publication.organizationId);
    if (!membership) throw new AppError(ErrorCode.NOT_FOUND, notFoundMessage); // 防枚举（文案与"行不存在"一致）
    return this.auth.authorize(userId, publication.organizationId, 'agent.write');
  }

  /**
   * 条目可见性：published → 任何已登录用户；其余状态 → 仅发布者组织成员（非成员 404，防枚举）。
   * 返回调用者的查看能力（供详情页回显；**只读展示**；`canModerate` 与裁决走**同一显式判定**，
   * 绝不出现"回显可审核但实际 403"或反之的口径分叉）。
   */
  async assertVisible(
    userId: string, publication: PublicationScopeRow, notFoundMessage = '资源不存在',
  ): Promise<ViewerCapabilities> {
    const platformAdmin = await this.isPlatformAdmin(userId);
    const membership = await this.auth.membership(userId, publication.organizationId);
    if (!isPubliclyVisible(publication.status as PublicationStatus)) {
      if (!membership && !platformAdmin) {
        // 未发布条目跨组织 404 防枚举；文案与调用方"行不存在"一致（BUG-13，防文案级存在性 oracle）
        throw new AppError(ErrorCode.NOT_FOUND, notFoundMessage);
      }
      // M10-P15（X-21）：未发布条目属组织数据面 → 禁用组织成员不可读（公开目录条目不受影响）。
      this.assertOrgActive(membership?.orgStatus);
    }
    const role = membership?.role ?? null;
    return {
      role,
      platformAdmin,
      canManage: role ? this.auth.can(role, 'agent.write') : false,
      // 治理能力 = 治理位判定（与 assertModerationRights 同一个 lookup，口径绝不与裁决分叉）
      canModerate: decideModeration({ role, platformAdmin }, this.roleLookup()).allowed,
    };
  }

  /**
   * 治理位漂移检测（**观测面，不参与裁决**）：治理位是治理权的唯一口径，裁决恒取该位；
   * 本方法把"矩阵授予面 ≠ 声明治理角色"的事实暴露给运维/审计——
   * leaked = 治理面被放大（判定随之放行该角色）、missing = 治理面被收紧（判定随之拒绝，fail-closed）。
   * 单测以真实矩阵断言一致 ⇒ 矩阵一改即红，强制人工复核。
   */
  private warnIfMatrixDrifted(): void {
    const audit = auditModerationMatrix(this.roleLookup());
    if (audit.consistent) return;
    this.logger.warn(
      `marketplace 治理位漂移：${audit.permission} leaked=[${audit.leakedRoles.join(',')}] `
      + `missing=[${audit.missingRoles.join(',')}]——裁决取该治理位（声明治理角色 ${MODERATION_ROLES.join('/')}），请人工复核矩阵`,
    );
  }
}
