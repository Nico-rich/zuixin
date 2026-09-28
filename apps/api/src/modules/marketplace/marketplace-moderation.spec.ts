import { describe, it, expect } from 'vitest';
import { OrganizationRole } from '@prisma/client';
import { AuthorizationService, roleHasPermission } from '../organizations/authorization.service';
import {
  ALL_ORGANIZATION_ROLES, MODERATION_PERMISSION, MODERATION_ROLES, RolePermissionLookup,
  auditModerationMatrix, canModerateMarketplace, decideModeration, isModerationRole,
} from './marketplace-moderation';

/**
 * M11-P12 治理**专用权限位** `marketplace.moderate` 单测（M10-P6 Deferred 落地）。
 *
 * 本文件的核心价值 = **权限矩阵变更敏感**（tripwire 已从旧借用位 `member.write` 迁移到专用位）：
 * - ③④ 以**真实矩阵**（`AuthorizationService.can`，无 IO）跑一致性审计与逐项锁定：
 *   矩阵一旦改动 `marketplace.moderate` 的授予面，本文件立即变红，强制人工复核治理面是否被放大/收紧；
 * - ⑥ tripwire 新口径：member 获得**旧借用位** `member.write` **不**改变治理权（该位已与治理彻底解耦）；
 *   member 获得**专用位** `marketplace.moderate` **才**改变治理权（显式授权，故绝不"静默"）；
 * - ⑦ 评分/审核状态/安装量绝不参与授权（M9-P6 不变量原样保留）。
 */

/** 真实矩阵查询器（AuthorizationService.can 为纯函数，构造 prisma 仅占位不触库） */
const realAuth = new AuthorizationService({} as never);
const realMatrix: RolePermissionLookup = (role, action) => realAuth.can(role, action);

/** 矩阵模拟器：只有 `roles` 持有 `action`（复现"矩阵改动"这一外部事件） */
function matrixWith(action: string, roles: readonly string[]): RolePermissionLookup {
  return (role, a) => a === action && roles.includes(role);
}

describe('marketplace-moderation（专用治理位 marketplace.moderate）', () => {
  it('① 声明治理角色为显式枚举 owner/admin；全部组织角色与 Prisma 枚举一一对应（新增角色即红）', () => {
    expect([...MODERATION_ROLES]).toEqual(['owner', 'admin']);
    // 逐个角色必须显式归类：Prisma 新增角色而此处未分类 → 本用例失败（deny-by-default 不会被绕过）
    expect([...ALL_ORGANIZATION_ROLES].sort()).toEqual([...Object.values(OrganizationRole)].sort());
    for (const role of Object.values(OrganizationRole)) {
      expect(isModerationRole(role)).toBe(MODERATION_ROLES.includes(role as never));
    }
    expect(isModerationRole('superuser' as never)).toBe(false); // 未知角色字面量 → 非声明治理角色
  });

  it('② 治理位 = marketplace.moderate（M11-P12 专用位；改名/改授予面必须显式复核本文件）', () => {
    expect(MODERATION_PERMISSION).toBe('marketplace.moderate');
  });

  it('③ 真实矩阵一致性审计：矩阵授予 marketplace.moderate 的角色恰为声明治理角色', () => {
    const audit = auditModerationMatrix(realMatrix);
    expect(audit.permission).toBe('marketplace.moderate');
    expect({ leakedRoles: audit.leakedRoles, missingRoles: audit.missingRoles }).toEqual({
      leakedRoles: [], missingRoles: [],
    });
    expect(audit.consistent).toBe(true);
  });

  it('④ 真实矩阵逐项锁定：owner/admin 持有治理位；member/viewer **不得**持有（矩阵改动 → 本用例变红）', () => {
    expect(realAuth.can('member', MODERATION_PERMISSION)).toBe(false);
    expect(realAuth.can('viewer', MODERATION_PERMISSION)).toBe(false);
    expect(realAuth.can('owner', MODERATION_PERMISSION)).toBe(true);
    expect(realAuth.can('admin', MODERATION_PERMISSION)).toBe(true);
    // 读/写面不因治理位改动（治理位只覆盖治理动作）
    expect(realAuth.can('member', 'agent.write')).toBe(true); // 发布者写权（未被本 Phase 改动）
    expect(realAuth.can('viewer', 'agent.write')).toBe(false);
  });

  it('⑤ 判定 consume 治理位：owner/admin 放行；member/viewer/非成员一律拒绝', () => {
    for (const role of ['owner', 'admin'] as const) {
      const decision = decideModeration({ role, platformAdmin: false });
      expect(decision).toMatchObject({ allowed: true, via: 'organization-governance' });
      expect(decision.reason).toContain(MODERATION_PERMISSION);
      expect(canModerateMarketplace({ role, platformAdmin: false })).toBe(true);
    }
    for (const role of ['member', 'viewer', null] as const) {
      const decision = decideModeration({ role, platformAdmin: false });
      expect(decision.allowed).toBe(false);
      expect(decision.via).toBe('none');
      expect(decision.reason).toContain('owner/admin');
      expect(decision.reason).toContain(MODERATION_PERMISSION);
      expect(canModerateMarketplace({ role, platformAdmin: false })).toBe(false);
    }
  });

  it('⑤ 平台管理员 = 窄口径逃生门（跨组织可治理，role 为 null 亦然；矩阵无关）', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer', null] as const) {
      const decision = decideModeration({ role, platformAdmin: true });
      expect(decision).toMatchObject({ allowed: true, via: 'platform-admin' });
    }
    // 即便矩阵把治理位全撤，平台管理员逃生门不受影响
    expect(canModerateMarketplace({ role: 'member', platformAdmin: true }, () => false)).toBe(true);
  });

  it('⑥ tripwire（M11-P12 新口径）：member 获**旧借用位** member.write **不**改变治理权', () => {
    // 旧借用位（M9-P6 的隐式推论）已彻底退出治理判定路径：即便矩阵把它授予 member/viewer，
    // 治理权也不随之改变（这正是 M10-P6 显式枚举要防的"静默放宽"，现由专用位取代）。
    const oldBitOnly = matrixWith('member.write', ['owner', 'admin', 'member', 'viewer']);
    expect(canModerateMarketplace({ role: 'member', platformAdmin: false }, oldBitOnly)).toBe(false);
    expect(canModerateMarketplace({ role: 'viewer', platformAdmin: false }, oldBitOnly)).toBe(false);
    // 审计亦不受旧位影响（审计只看治理位）
    const audit = auditModerationMatrix(oldBitOnly);
    expect(audit.consistent).toBe(false); // 治理位在此矩阵中无人持有 → missing（旧位不是治理位）
    expect([...audit.missingRoles].sort()).toEqual(['admin', 'owner']);
    expect(audit.leakedRoles).toEqual([]);
  });

  it('⑥ tripwire（M11-P12 新口径）：member 获**专用位** marketplace.moderate **才**改变治理权', () => {
    const dedicatedToMember = matrixWith(MODERATION_PERMISSION, ['owner', 'admin', 'member']);
    // 显式授予 → 治理权随之改变（不再"静默"：这是矩阵里可 grep、可单测锁定的授权事实）
    expect(canModerateMarketplace({ role: 'member', platformAdmin: false }, dedicatedToMember)).toBe(true);
    // 同一次矩阵改动必须让审计变红（leaked=member）→ 强制人工复核
    const audit = auditModerationMatrix(dedicatedToMember);
    expect(audit.consistent).toBe(false);
    expect(audit.leakedRoles).toEqual(['member']);
    expect(audit.missingRoles).toEqual([]);
    // 未获得该位的角色不受影响
    expect(canModerateMarketplace({ role: 'viewer', platformAdmin: false }, dedicatedToMember)).toBe(false);
  });

  it('⑥ 治理位收紧（声明治理角色失去该位）→ 治理权随之收紧（fail-closed，绝不越权放行）', () => {
    const audit = auditModerationMatrix(() => false);
    expect(audit.consistent).toBe(false);
    expect(audit.leakedRoles).toEqual([]);
    expect([...audit.missingRoles].sort()).toEqual(['admin', 'owner']);
    // 矩阵撤位 ⇒ 判定拒绝（旧 M10-P6 口径是"仍可治理"，专用位落地后改为与矩阵一致地 fail-closed）
    expect(canModerateMarketplace({ role: 'admin', platformAdmin: false }, () => false)).toBe(false);
    expect(decideModeration({ role: 'owner', platformAdmin: false }, () => false).allowed).toBe(false);
  });

  it('⑥ 未知/未来角色字面量：矩阵无该行 → 拒绝且不抛错（deny-by-default 不被绕过）', () => {
    expect(canModerateMarketplace({ role: 'superuser' as never, platformAdmin: false })).toBe(false);
    expect(roleHasPermission('superuser' as never, MODERATION_PERMISSION)).toBe(false);
    expect(decideModeration({ role: 'superuser' as never, platformAdmin: false }).allowed).toBe(false);
  });

  it('⑦ 评分/审核状态/安装量绝不参与授权（伪造额外字段不改变判定）', () => {
    const memberBase = { role: 'member', platformAdmin: false };
    // 高分/已通过也不放宽（评分永不提升权限——M9-P6 不变量）
    expect(canModerateMarketplace({ ...memberBase, rating: 5, moderationStatus: 'approved', installCount: 9_999 } as never)).toBe(false);
    expect(canModerateMarketplace({ ...memberBase, rating: 1, moderationStatus: 'rejected', installCount: 0 } as never)).toBe(false);
    // 反向：治理角色不因低分/被驳回状态失权（判定只吃 role + platformAdmin + 治理位）
    expect(canModerateMarketplace({ role: 'owner', platformAdmin: false, rating: 1, moderationStatus: 'rejected' } as never)).toBe(true);
  });
});
