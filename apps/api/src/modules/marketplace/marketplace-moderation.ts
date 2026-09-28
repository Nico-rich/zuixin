/**
 * M11-P12 Marketplace 治理（moderation）**专用权限位** `marketplace.moderate`——本模块唯一事实源。
 *
 * ### 演进（M9-P6 借用 → M10-P6 显式枚举 → M11-P12 专用位落地）
 * - **M9-P6**：审核裁决**借用**组织 RBAC 的 `member.write` 位，依据是"当前矩阵中**恰好**只有
 *   owner/admin 命中"（M9 Final Baseline §5 已知降级："marketplace moderation 复用 member.write
 *   是语义借用"）。这是对权限矩阵的**隐式推论**：矩阵一旦调整即静默改变治理面，且无测试变红；
 * - **M10-P6**：改为**显式角色枚举**（`MODERATION_ROLES` = owner/admin ∨ 平台管理员），判定与矩阵
 *   完全解耦（矩阵漂移绝不放宽治理权），并在本文件顶部登记 Deferred：更干净的终态是**专用治理位**
 *   （`marketplace.moderate`），文档明写"若 M11 引入该位，**唯一改动点是本文件**，全部调用方零改动"；
 * - **M11-P12（本 Phase）**：**Deferred 已落地**——新增 `marketplace.moderate` 权限位
 *   （`organizations/authorization.service.ts`：owner/admin = 有，member/viewer = 无），
 *   判定**consume 该位**：治理权 = 调用者角色持有 `marketplace.moderate` ∨ 平台管理员。
 *
 * ### 判定口径（唯一入口；不再有"借用"与"显式枚举"的分叉）
 * - 授权输入 = `{ role, platformAdmin }`（评分/审核状态/安装量在类型上不可达）+ 权限位查询器
 *   （默认 = 真实矩阵的**纯查询** `roleHasPermission`，无 IO、无实例；调用方可传自己的同源查询器）；
 * - `MODERATION_ROLES`（owner/admin）**不再直接决定放行**，退居为**矩阵审计对照**：
 *   `auditModerationMatrix` 比对"矩阵实际授予 `marketplace.moderate` 的角色集合"与声明治理角色集合——
 *   - `leakedRoles`：非声明治理角色却持有该位 → 治理面被**显式放大**（须人工复核该授权是否本意）；
 *   - `missingRoles`：声明治理角色失去该位 → 治理面被**收紧**（fail-closed：判定随之拒绝）；
 * - 单测以**真实矩阵**跑该审计并断言一致 ⇒ **矩阵一改即红**，强制人工复核。这取代了 M10-P6
 *   "角色硬编码 + 矩阵漂移告警"的临时锁：治理权现在来自一个**可审计、可 grep、可单测锁定**的授权位；
 * - 与 `member.write`（组织成员管理）**彻底解耦**：该位不在治理判定路径上——member 日后获得
 *   `member.write` 绝不改变治理权（单测 ⑥ 锁定，tripwire 已迁移到 `marketplace.moderate`）。
 *
 * ### fail-closed
 * 未知角色字面量（Prisma 枚举未来新增）/ 矩阵无该行 → `false`（矩阵查询器 `?? []` 兜底，不抛出、
 * 不放行）。新角色必须**显式**决定是否授予治理位（deny-by-default 不因"查不到"被绕过）。
 *
 * ### 不变量（M9-P6 语义原样保留）
 * - **评分/审核状态/安装量绝不参与授权**：本文件只吃 `role` + `platformAdmin` + 治理位；
 *   评分在类型上不可达（单测用"伪造额外字段"的对象复核：rating=1/5 都不改变判定）；
 * - 治理动作**只**覆盖评审审核与条目驳回；内容编辑/发布/撤回恒为 `agent.write`（发布者写权），
 *   平台管理员**不**因治理权获得内容编辑能力；
 * - 非成员一律由调用方按 404 防枚举处理（本文件只在成员身份已确定后使用；role=null 仅表示
 *   "无组织角色"，判定返回 false）。
 */

import { OrganizationRole } from '@prisma/client';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { OrgPermission, roleHasPermission } from '../organizations/authorization.service';

/**
 * 治理角色白名单（**声明式口径**：矩阵审计的对照集合，见 `auditModerationMatrix`）。
 * 增删必须是显式代码改动 + 测试复核（见 marketplace-moderation.spec.ts）；
 * 该集合**不再**单独决定放行——放行 = 矩阵对 `MODERATION_PERMISSION` 的授予。
 */
export type ModerationRole = 'owner' | 'admin';
export const MODERATION_ROLES: readonly ModerationRole[] = ['owner', 'admin'];

/**
 * 治理权**唯一权限位**（M11-P12 专用位；矩阵口径：owner/admin = 有，member/viewer = 无）。
 * 语义改变（改名/改矩阵授予面）必须显式复核本文件与 authorization.service.ts 的矩阵。
 */
export const MODERATION_PERMISSION: OrgPermission = 'marketplace.moderate';

/**
 * 全部组织角色（必须与 Prisma `OrganizationRole` 枚举一一对应——单测逐字比对，新增角色即红）。
 * 新角色被加入时，必须显式决定其是否在矩阵中获得 `marketplace.moderate`（deny-by-default：不授予即无治理权）。
 */
export const ALL_ORGANIZATION_ROLES: readonly OrganizationRole[] = ['owner', 'admin', 'member', 'viewer'];

/** 治理判定主体（**只有这两个字段**：评分/审核状态/安装量在类型上不可达） */
export interface ModerationSubject {
  /** 调用者在发布者组织中的角色（非成员 → null；非成员的存在性隐藏由调用方按 404 处理） */
  role: OrganizationRole | null;
  /** 平台管理员（user.role='admin'）：市场治理面窄口径逃生门（跨组织审核，不含内容编辑） */
  platformAdmin: boolean;
}

/** 权限矩阵查询器（`AuthorizationService.can` 的形状；纯函数，无 IO）——判定与审计同源 */
export type RolePermissionLookup = (role: OrganizationRole, action: OrgPermission) => boolean;

/** 判定来源（审计/日志友好；**绝不**作为授权输入回流） */
export type ModerationVia = 'platform-admin' | 'organization-governance' | 'none';

export interface ModerationDecision {
  allowed: boolean;
  via: ModerationVia;
  /** 拒绝理由（FORBIDDEN 响应文案；放行时为处置说明） */
  reason: string;
}

/**
 * 角色是否被**声明**为治理角色（矩阵审计对照；未知/新增角色字面量一律 false）。
 * 注意：这不是授权判定（授权看 `MODERATION_PERMISSION` 位），仅用于审计报告与 deny-by-default 测试。
 */
export function isModerationRole(role: OrganizationRole | null | undefined): role is ModerationRole {
  return role != null && (MODERATION_ROLES as readonly string[]).includes(role);
}

/**
 * 治理判定（**consume `marketplace.moderate` 位**，显式布尔 + 来源）。
 *
 * - `lookup` 省略时 = 真实权限矩阵纯查询（`roleHasPermission`，无 IO）——调用方零改动；
 *   传入自定义查询器即"模拟矩阵改动"（单测用；生产调用方传自己的 `auth.can` 以保持单一事实源）。
 * - 平台管理员优先（逃生门，矩阵无关）；否则**仅**看治理位：持有 → 放行，未持有 → 拒绝。
 *   role=null（无组织角色）恒拒绝。
 */
export function decideModeration(
  subject: ModerationSubject,
  lookup: RolePermissionLookup = roleHasPermission,
): ModerationDecision {
  if (subject.platformAdmin) {
    return { allowed: true, via: 'platform-admin', reason: '平台管理员（市场治理面窄口径）' };
  }
  if (subject.role != null && lookup(subject.role, MODERATION_PERMISSION)) {
    return {
      allowed: true,
      via: 'organization-governance',
      reason: `持有 ${MODERATION_PERMISSION} 治理位（当前矩阵：${MODERATION_ROLES.join('/')}）`,
    };
  }
  return {
    allowed: false,
    via: 'none',
    reason: `仅持有 ${MODERATION_PERMISSION} 的组织角色（${MODERATION_ROLES.join('/')}）或平台管理员可执行治理动作`,
  };
}

/** 显式布尔（审核端点一律走本函数；调用方不得自行推导治理权） */
export function canModerateMarketplace(
  subject: ModerationSubject,
  lookup: RolePermissionLookup = roleHasPermission,
): boolean {
  return decideModeration(subject, lookup).allowed;
}

/** 判定 + 拒绝即抛 403（判定唯一入口的"断言"形态；绝不抛出后仍继续执行） */
export function assertModerationDecision(
  subject: ModerationSubject,
  lookup: RolePermissionLookup = roleHasPermission,
): ModerationDecision {
  const decision = decideModeration(subject, lookup);
  if (!decision.allowed) throw new AppError(ErrorCode.FORBIDDEN, decision.reason);
  return decision;
}

// ===== 矩阵漂移检测（治理位 ↔ 声明治理角色的一致性；观测面，不参与裁决） =====

export interface ModerationMatrixAudit {
  permission: OrgPermission;
  /** 一致 = 无泄露且无缺失（矩阵授予面恰为声明治理角色） */
  consistent: boolean;
  /** 非声明治理角色却持有该位 → 治理面被显式放大（须人工复核；单测以真实矩阵断言为空 ⇒ 矩阵一改即红） */
  leakedRoles: OrganizationRole[];
  /** 声明治理角色却未持有该位 → 治理面被收紧（判定 fail-closed 拒绝；须人工复核） */
  missingRoles: OrganizationRole[];
}

/**
 * 复核 `MODERATION_PERMISSION` 的矩阵授予面与声明治理角色是否一致（纯函数，传入矩阵查询器即可离线跑）。
 * 真实矩阵的调用点：MarketplaceAccessService（每次治理裁决时告警）+ 单测（矩阵变更即红）。
 * **本函数不改变任何裁决结果**——裁决恒取治理位本身，审计只把漂移暴露给运维/测试。
 */
export function auditModerationMatrix(lookup: RolePermissionLookup): ModerationMatrixAudit {
  const leakedRoles = ALL_ORGANIZATION_ROLES.filter(
    (role) => !isModerationRole(role) && lookup(role, MODERATION_PERMISSION),
  );
  const missingRoles = ALL_ORGANIZATION_ROLES.filter(
    (role) => isModerationRole(role) && !lookup(role, MODERATION_PERMISSION),
  );
  return {
    permission: MODERATION_PERMISSION,
    consistent: leakedRoles.length === 0 && missingRoles.length === 0,
    leakedRoles,
    missingRoles,
  };
}
