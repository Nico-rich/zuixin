import { describe, it, expect } from 'vitest';
import { OrganizationRole } from '@prisma/client';
import { AuthorizationService } from '../organizations/authorization.service';
import {
  ALL_ORGANIZATION_ROLES, MODERATION_MATRIX_PERMISSION, MODERATION_ROLES, RolePermissionLookup,
  auditModerationMatrix, canModerateMarketplace, decideModeration, isModerationRole,
} from './marketplace-moderation';

/**
 * M10-P6 治理权限显式判定单测（审计 D7 / M9-02 闭环）。
 *
 * 本文件的核心价值 = **权限矩阵变更敏感**：
 * - ③④ 以**真实矩阵**（`AuthorizationService.can`，无 IO）运行一致性审计：
 *   矩阵一旦把 `member.write` 授予非治理角色（或从治理角色撤走），本文件立即变红，
 *   强制人工复核"治理权是否被静默放宽"——这是 M9-P6 "恰好只有 owner/admin 命中"隐式推论的替代锁；
 * - ⑤⑥ 锁死**判定与矩阵解耦**：即使矩阵放宽，治理权也不会随之放宽（fail-closed）。
 */

/** 真实矩阵查询器（AuthorizationService.can 为纯函数，构造 prisma 仅占位不触库） */
const realAuth = new AuthorizationService({} as never);
const realMatrix: RolePermissionLookup = (role, action) => realAuth.can(role, action);

describe('marketplace-moderation（显式治理判定）', () => {
  it('① 治理角色为显式枚举 owner/admin；全部组织角色与 Prisma 枚举一一对应（新增角色即红）', () => {
    expect([...MODERATION_ROLES]).toEqual(['owner', 'admin']);
    // 逐个角色必须显式归类：Prisma 新增角色而此处未分类 → 本用例失败（deny-by-default 不会被绕过）
    expect([...ALL_ORGANIZATION_ROLES].sort()).toEqual([...Object.values(OrganizationRole)].sort());
    for (const role of Object.values(OrganizationRole)) {
      expect(isModerationRole(role)).toBe(MODERATION_ROLES.includes(role as never));
    }
    expect(isModerationRole('superuser' as never)).toBe(false); // 未知角色字面量 → 无治理权
  });

  it('② 矩阵耦合锚 = member.write（M9 借用位；语义改变必须显式复核本文件）', () => {
    expect(MODERATION_MATRIX_PERMISSION).toBe('member.write');
  });

  it('③ 真实矩阵一致性审计：无泄露（非治理角色不得持有该位）、无缺失（治理角色须持有）', () => {
    const audit = auditModerationMatrix(realMatrix);
    expect({ leakedRoles: audit.leakedRoles, missingRoles: audit.missingRoles }).toEqual({
      leakedRoles: [], missingRoles: [],
    });
    expect(audit.consistent).toBe(true);
  });

  it('④ 真实矩阵逐项锁定：owner/admin 持有；member/viewer **不得**持有（矩阵放宽 → 本用例变红）', () => {
    // 这一行就是 M9-P6 隐式借用的依据本身：member 一旦获得 member.write，治理语义即漂移（须人工复核）
    expect(realAuth.can('member', MODERATION_MATRIX_PERMISSION)).toBe(false);
    expect(realAuth.can('viewer', MODERATION_MATRIX_PERMISSION)).toBe(false);
    expect(realAuth.can('owner', MODERATION_MATRIX_PERMISSION)).toBe(true);
    expect(realAuth.can('admin', MODERATION_MATRIX_PERMISSION)).toBe(true);
  });

  it('⑤ 显式判定：owner/admin 可治理；member/viewer/非成员一律不可（不读矩阵）', () => {
    for (const role of ['owner', 'admin'] as const) {
      const decision = decideModeration({ role, platformAdmin: false });
      expect(decision).toMatchObject({ allowed: true, via: 'organization-governance' });
      expect(canModerateMarketplace({ role, platformAdmin: false })).toBe(true);
    }
    for (const role of ['member', 'viewer', null] as const) {
      const decision = decideModeration({ role, platformAdmin: false });
      expect(decision.allowed).toBe(false);
      expect(decision.via).toBe('none');
      expect(decision.reason).toContain('owner/admin');
      expect(canModerateMarketplace({ role, platformAdmin: false })).toBe(false);
    }
  });

  it('⑤ 平台管理员 = 窄口径逃生门（跨组织可治理，role 为 null 亦然）', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer', null] as const) {
      const decision = decideModeration({ role, platformAdmin: true });
      expect(decision).toMatchObject({ allowed: true, via: 'platform-admin' });
    }
  });

  it('⑥ 矩阵放宽模拟：member 获得 member.write 亦**绝不**获得治理权（fail-closed）', () => {
    const widened: RolePermissionLookup = () => true; // 极端放宽：所有角色持有该位
    const audit = auditModerationMatrix(widened);
    expect(audit.consistent).toBe(false);
    expect([...audit.leakedRoles].sort()).toEqual(['member', 'viewer']); // 治理角色不算泄露
    expect(audit.missingRoles).toEqual([]);
    // 判定结果与矩阵完全无关：member 仍然不可治理
    expect(canModerateMarketplace({ role: 'member', platformAdmin: false })).toBe(false);
  });

  it('⑥ 矩阵收紧模拟：治理角色失去该位仍可治理（判定不依赖该位；缺失仅记录语义漂移）', () => {
    const audit = auditModerationMatrix(() => false);
    expect(audit.consistent).toBe(false);
    expect(audit.leakedRoles).toEqual([]);
    expect([...audit.missingRoles].sort()).toEqual(['admin', 'owner']);
    expect(canModerateMarketplace({ role: 'admin', platformAdmin: false })).toBe(true);
  });

  it('⑦ 评分/审核状态/安装量绝不参与授权（伪造额外字段不改变判定）', () => {
    const memberBase = { role: 'member', platformAdmin: false };
    // 高分/已通过也不放宽（评分永不提升权限——M9-P6 不变量）
    expect(canModerateMarketplace({ ...memberBase, rating: 5, moderationStatus: 'approved', installCount: 9_999 } as never)).toBe(false);
    expect(canModerateMarketplace({ ...memberBase, rating: 1, moderationStatus: 'rejected', installCount: 0 } as never)).toBe(false);
    // 反向：治理角色不因低分/被驳回状态失权（判定只吃 role + platformAdmin）
    expect(canModerateMarketplace({ role: 'owner', platformAdmin: false, rating: 1, moderationStatus: 'rejected' } as never)).toBe(true);
  });
});
