/**
 * M10-P6 Marketplace 治理（moderation）**显式权限判定**——本模块唯一事实源（闭环审计 D7 / M9-02）。
 *
 * ### 被闭环的问题
 * M9-P6 的审核裁决**借用**了组织 RBAC 的 `member.write` 位，依据是"当前矩阵中**恰好**只有
 * owner/admin 命中"（M9 Final Baseline §5 已知降级："marketplace moderation 复用 member.write
 * 是语义借用"）。这是对权限矩阵的**隐式推论**：矩阵一旦调整（例如 member 获得 member.write，
 * 或某新角色被授予该位），治理权会**静默放宽**，且没有任何测试会变红。
 *
 * ### 本文件的处置：显式枚举 + 双向锁定（不新增权限位）
 * 1. **判定显式化**：治理权 = 组织 role ∈ `MODERATION_ROLES`（owner/admin，此处显式枚举）
 *    ∨ 平台管理员（市场治理面的窄口径逃生门）。判定函数**不读取权限矩阵**——
 *    `canModerateMarketplace` / `decideModeration` 的入参只有 `{ role, platformAdmin }`，
 *    类型上就没有权限位调查器（contract-level：没有 lookup 参数可传）。
 * 2. **矩阵耦合点唯一化**：`MODERATION_MATRIX_PERMISSION`（历史上被借用的那个位）只保留为
 *    **一致性锚**，由 `auditModerationMatrix` 复核：
 *    - `leakedRoles`：**非治理角色**却持有该位 → 治理语义已漂移（矩阵改动使"借用"的旧口径
 *      会放宽治理权）；
 *    - `missingRoles`：治理角色却不再持有该位 → 旧耦合口径已断裂。
 *    两者都**不改变裁决结果**（判定与矩阵解耦 → 永不因矩阵变动放宽），只作为告警/审计暴露给运维；
 *    单测以**真实矩阵**运行 `auditModerationMatrix` 并断言一致 —— 矩阵一改即红，强制人工复核治理语义。
 * 3. **fail-closed**：未知角色字面量（Prisma 枚举未来新增）一律 `false`——新角色必须显式归类
 *    才会获得治理权（`ALL_ORGANIZATION_ROLES` 与 Prisma 枚举的一致性由单测锁定）。
 *
 * ### 不变量（M9-P6 语义原样保留）
 * - **评分/审核状态/安装量绝不参与授权**：本文件只吃 `role` + `platformAdmin` 两个入参，
 *   评分在类型上不可达（单测用"伪造额外字段"的对象复核：rating=1/5 都不改变判定）；
 * - 治理动作**只**覆盖评审审核与条目驳回；内容编辑/发布/撤回恒为 `agent.write`（发布者写权），
 *   平台管理员**不**因治理权获得内容编辑能力；
 * - 非成员一律由调用方按 404 防枚举处理（本文件只在成员身份已确定后使用；role=null 仅表示
 *   "无组织角色"，判定返回 false）。
 *
 * ### 权限位缺口（Deferred → M11+；本轮 schema / M9 冻结矩阵不动，如实记录不伪装）
 * 更干净的终态是新增**专用治理位**（如 `marketplace.moderate`）：
 * - 设计：`OrgPermission` 增 `marketplace.moderate`；矩阵 owner/admin = 有，member/viewer = 无；
 *   与 `member.write`（组织成员管理）彻底解耦——member 日后若获得 member.write，不会连带获得治理权
 *   （该路径本文件已用显式枚举先行阻断，故此项是"语义整洁"而非安全缺口）；
 * - 风险/成本：改 `apps/api/src/modules/organizations/authorization.service.ts`（**非本模块所有权**）
 *   + 冻结矩阵新增位（M9 基线声明"不新增权限位"）+ 需评估既有角色语义漂移；
 * - 结论：**本 Phase 不实施**（M10 §9 安全边界：不为修问题大规模重构、不新增 RBAC 位）。
 *   若 M11 引入该位，**唯一改动点是本文件**（`MODERATION_ROLES` 与判定函数），全部调用方零改动。
 */

import { OrganizationRole } from '@prisma/client';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type { OrgPermission } from '../organizations/authorization.service';

/**
 * 治理角色白名单（**显式枚举**：治理语义的唯一口径，绝不从权限矩阵反推）。
 * 增删必须是显式代码改动 + 测试复核（见 marketplace-moderation.spec.ts）。
 */
export type ModerationRole = 'owner' | 'admin';
export const MODERATION_ROLES: readonly ModerationRole[] = ['owner', 'admin'];

/**
 * 权限矩阵耦合锚：M9-P6 曾借用、本 Phase 起**不再用于裁决**的权限位。
 * 仅用于 `auditModerationMatrix` 检测矩阵漂移（告警不降级）。
 */
export const MODERATION_MATRIX_PERMISSION: OrgPermission = 'member.write';

/**
 * 全部组织角色（必须与 Prisma `OrganizationRole` 枚举一一对应——单测逐字比对，新增角色即红）。
 * 新角色被加入时，必须显式决定其是否属于 `MODERATION_ROLES`（deny-by-default：不列入即无治理权）。
 */
export const ALL_ORGANIZATION_ROLES: readonly OrganizationRole[] = ['owner', 'admin', 'member', 'viewer'];

/** 治理判定主体（**只有这两个字段**：评分/审核状态/安装量在类型上不可达） */
export interface ModerationSubject {
  /** 调用者在发布者组织中的角色（非成员 → null；非成员的存在性隐藏由调用方按 404 处理） */
  role: OrganizationRole | null;
  /** 平台管理员（user.role='admin'）：市场治理面窄口径逃生门（跨组织审核，不含内容编辑） */
  platformAdmin: boolean;
}

/** 判定来源（审计/日志友好；**绝不**作为授权输入回流） */
export type ModerationVia = 'platform-admin' | 'organization-governance' | 'none';

export interface ModerationDecision {
  allowed: boolean;
  via: ModerationVia;
  /** 拒绝理由（FORBIDDEN 响应文案；放行时为处置说明） */
  reason: string;
}

/** 角色是否为治理角色（显式枚举；未知/新增角色字面量一律 false——deny-by-default） */
export function isModerationRole(role: OrganizationRole | null | undefined): role is ModerationRole {
  return role != null && (MODERATION_ROLES as readonly string[]).includes(role);
}

/**
 * 治理判定（显式布尔 + 来源）：**不读取权限矩阵**（入参无语义外字段即为契约）。
 * 平台管理员优先（逃生门）；否则仅组织 owner/admin。
 */
export function decideModeration(subject: ModerationSubject): ModerationDecision {
  if (subject.platformAdmin) {
    return { allowed: true, via: 'platform-admin', reason: '平台管理员（市场治理面窄口径）' };
  }
  if (isModerationRole(subject.role)) {
    return {
      allowed: true,
      via: 'organization-governance',
      reason: `发布者组织治理角色（${MODERATION_ROLES.join('/')}）`,
    };
  }
  return {
    allowed: false,
    via: 'none',
    reason: `仅发布者组织 ${MODERATION_ROLES.join('/')}（治理角色）或平台管理员可执行治理动作`,
  };
}

/** 显式布尔（审核端点一律走本函数；调用方不得自行推导治理权） */
export function canModerateMarketplace(subject: ModerationSubject): boolean {
  return decideModeration(subject).allowed;
}

/** 判定 + 拒绝即抛 403（判定唯一入口的"断言"形态；绝不抛出后仍继续执行） */
export function assertModerationDecision(subject: ModerationSubject): ModerationDecision {
  const decision = decideModeration(subject);
  if (!decision.allowed) throw new AppError(ErrorCode.FORBIDDEN, decision.reason);
  return decision;
}

// ===== 矩阵漂移检测（告警不降级：判定已与矩阵解耦，漂移绝不放宽/收紧裁决） =====

/** 权限矩阵查询器（`AuthorizationService.can` 的形状；纯函数，无 IO） */
export type RolePermissionLookup = (role: OrganizationRole, action: OrgPermission) => boolean;

export interface ModerationMatrixAudit {
  permission: OrgPermission;
  /** 一致 = 无泄露且无缺失 */
  consistent: boolean;
  /** 非治理角色却持有该位 → 矩阵改动会（在旧的"借用"口径下）静默放宽治理权 */
  leakedRoles: OrganizationRole[];
  /** 治理角色却不再持有该位 → 旧耦合口径已断裂（治理权不受影响，仅记录语义漂移） */
  missingRoles: OrganizationRole[];
}

/**
 * 复核 `MODERATION_MATRIX_PERMISSION` 与治理角色的语义一致性（纯函数，传入矩阵查询器即可离线跑）。
 * 真实矩阵的调用点：MarketplaceAccessService（每次治理裁决时告警）+ 单测（矩阵变更即红）。
 */
export function auditModerationMatrix(lookup: RolePermissionLookup): ModerationMatrixAudit {
  const leakedRoles = ALL_ORGANIZATION_ROLES.filter(
    (role) => !isModerationRole(role) && lookup(role, MODERATION_MATRIX_PERMISSION),
  );
  const missingRoles = ALL_ORGANIZATION_ROLES.filter(
    (role) => isModerationRole(role) && !lookup(role, MODERATION_MATRIX_PERMISSION),
  );
  return {
    permission: MODERATION_MATRIX_PERMISSION,
    consistent: leakedRoles.length === 0 && missingRoles.length === 0,
    leakedRoles,
    missingRoles,
  };
}
