import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { AuthorizationService } from '../organizations/authorization.service';
import { MarketplaceAccessService, PublicationScopeRow } from './marketplace-access.service';

/**
 * M10-P6 归属/治理裁决单测（此前缺失的一层：e2e 之外没有 access 服务的直接覆盖）。
 *
 * 关键断言：
 * ① 治理裁决走**显式函数**（role ∈ owner/admin），**绝不**再借 `auth.authorize(..., 'member.write')`；
 * ② **矩阵放宽模拟**：即使矩阵把 member.write 授予 member（或授予全部角色），member 仍 403（fail-closed）；
 * ③ 矩阵收紧模拟：治理角色失去该位仍可治理（判定与矩阵解耦）；漂移仅告警（不降级）；
 * ④ 防枚举口径不变（非成员 404 / 成员无治理角色 403）；viewer 能力与裁决同源（无口径分叉）。
 *
 * 真实矩阵 + 真实 AuthorizationService（prisma 仅提供 membership/user 假行，无 IO）。
 */

const ORG = 'org-1';
const XRW_ORG = 'org-x';

function pub(over: Partial<PublicationScopeRow> = {}): PublicationScopeRow & { id: string } {
  return { id: 'pub-1', organizationId: ORG, userId: 'publisher', extensionId: 'ext-1', status: 'published', ...over };
}

function makeHarness(opts: {
  role?: OrganizationRole | null; userRole?: string; orgExists?: boolean;
} = {}) {
  const role = opts.role === undefined ? ('owner' as OrganizationRole) : opts.role;
  const prisma = {
    organization: { findFirst: vi.fn(async () => (opts.orgExists === false ? null : { id: ORG })) },
    organizationMember: { findUnique: vi.fn(async () => (role === null ? null : { role })) },
    user: { findUnique: vi.fn(async () => ({ role: opts.userRole ?? 'user' })) },
  };
  const auth = new AuthorizationService(prisma as never);
  const service = new MarketplaceAccessService(prisma as never, auth as never);
  return { service, prisma, auth };
}

/** 矩阵改动模拟：仅覆盖 `can`（裁决若仍依赖矩阵，就会在此暴露） */
function widenMatrix(auth: AuthorizationService): void {
  const original = auth.can.bind(auth);
  vi.spyOn(auth, 'can').mockImplementation((r, a) => (a === 'member.write' ? true : original(r, a)));
}

afterEach(() => vi.restoreAllMocks());

describe('MarketplaceAccessService（治理显式判定 + 防枚举）', () => {
  it('① 当前矩阵下：owner/admin 可治理；member/viewer 403；非成员 404（防枚举）', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const h = makeHarness({ role });
      await expect(h.service.assertModerationRights('u1', pub())).resolves.toBe(role);
    }
    for (const role of ['member', 'viewer'] as const) {
      const h = makeHarness({ role });
      await expect(h.service.assertModerationRights('u1', pub()))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(h.auth.authorize).toBeTypeOf('function'); // 服务实例正常构造（不触库）
    }
    // 非成员（无成员行）→ 404：与"条目不存在"不可区分（存在性不泄露）
    const outsider = makeHarness({ role: null });
    await expect(outsider.service.assertModerationRights('u-outsider', pub()))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('① 治理裁决**不再**借用 member.write：不调用 auth.authorize（权限位路径）', async () => {
    const h = makeHarness({ role: 'owner' });
    const spy = vi.spyOn(h.auth, 'authorize');
    await h.service.assertModerationRights('u1', pub());
    expect(spy).not.toHaveBeenCalled();
    // 对照：发布者写权仍走权限位路径（未被本 Phase 改动）
    await h.service.assertPublicationWrite('u1', pub());
    expect(spy).toHaveBeenCalledWith('u1', ORG, 'agent.write');
  });

  it('② 矩阵放宽模拟（member 获得 member.write）→ member 仍 403，治理权绝不静默放宽', async () => {
    const h = makeHarness({ role: 'member' });
    expect(h.auth.can('member', 'member.write')).toBe(false); // 当前矩阵事实
    widenMatrix(h.auth);
    expect(h.auth.can('member', 'member.write')).toBe(true); // 模拟未来矩阵改动
    await expect(h.service.assertModerationRights('u1', pub()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('② 矩阵全量放宽（所有角色持有 all 位）→ 非治理角色一律 403（防枚举口径不变）', async () => {
    for (const role of ['member', 'viewer'] as const) {
      const h = makeHarness({ role });
      vi.spyOn(h.auth, 'can').mockReturnValue(true);
      await expect(h.service.assertModerationRights('u1', pub()))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('③ 矩阵收紧模拟（治理角色失去该位）→ owner/admin 仍可治理；漂移仅告警不降级', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const h = makeHarness({ role: 'admin' });
    const original = h.auth.can.bind(h.auth);
    vi.spyOn(h.auth, 'can').mockImplementation((r, a) => (a === 'member.write' ? false : original(r, a)));
    await expect(h.service.assertModerationRights('u1', pub())).resolves.toBe('admin');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('权限矩阵漂移'));

    // 当前矩阵一致 → 无告警（本用例同时锁定"漂移才告警"）
    warn.mockClear();
    const clean = makeHarness({ role: 'admin' });
    await clean.service.assertModerationRights('u1', pub());
    expect(warn).not.toHaveBeenCalled();
  });

  it('④ 平台管理员逃生门：跨组织（非成员）亦可治理；组织不存在同样放行', async () => {
    const h = makeHarness({ role: null, userRole: 'admin' });
    await expect(h.service.assertModerationRights('u-admin', pub({ organizationId: XRW_ORG })))
      .resolves.toBe('platform');
    const gone = makeHarness({ role: null, userRole: 'admin', orgExists: false });
    await expect(gone.service.assertModerationRights('u-admin', pub())).resolves.toBe('platform');
  });

  it('⑤ viewer 能力与裁决同源（canModerate 不得与实际裁决分叉）', async () => {
    const expectations: Array<[OrganizationRole | null, boolean, boolean]> = [
      // role, canManage(agent.write), canModerate(治理)
      ['owner', true, true],
      ['admin', true, true],
      ['member', true, false],
      ['viewer', false, false],
      [null, false, false],
    ];
    for (const [role, canManage, canModerate] of expectations) {
      const h = makeHarness({ role });
      const caps = await h.service.assertVisible('u1', pub());
      expect(caps).toMatchObject({ role, canManage, canModerate });
      // 同源断言：canModerate 为 true ⇔ assertModerationRights 放行
      const ruling = h.service.assertModerationRights('u1', pub());
      if (canModerate) await expect(ruling).resolves.toBeTruthy();
      else if (role === null) await expect(ruling).rejects.toMatchObject({ code: 'NOT_FOUND' });
      else await expect(ruling).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // member 即便矩阵放宽，回显口径同样不放宽（否则前端会显示"可审核"但请求 403）
    const widened = makeHarness({ role: 'member' });
    widenMatrix(widened.auth);
    expect(await widened.service.assertVisible('u1', pub())).toMatchObject({ canModerate: false });
  });

  it('⑤ 平台管理员回显 canModerate=true 且平台级条目详情可见', async () => {
    const h = makeHarness({ role: null, userRole: 'admin' });
    const caps = await h.service.assertVisible('u-admin', pub());
    expect(caps).toMatchObject({ role: null, platformAdmin: true, canManage: false, canModerate: true });
  });

  it('⑥ 可见性防枚举：published 公开；未发布跨组织 404；未发布本组织成员可见', async () => {
    const outsider = makeHarness({ role: null });
    await expect(outsider.service.assertVisible('u-x', pub({ status: 'published' }))).resolves.toMatchObject({ role: null });
    await expect(outsider.service.assertVisible('u-x', pub({ status: 'draft' })))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(outsider.service.assertVisible('u-x', pub({ status: 'rejected' })))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    const member = makeHarness({ role: 'member' });
    await expect(member.service.assertVisible('u1', pub({ status: 'draft' }))).resolves.toMatchObject({ role: 'member' });
  });

  it('⑦ 发布者写权口径未被本 Phase 改动（agent.write；非成员 404）', async () => {
    await expect(makeHarness({ role: 'member' }).service.assertPublicationWrite('u1', pub())).resolves.toBe('member');
    await expect(makeHarness({ role: 'viewer' }).service.assertPublicationWrite('u1', pub()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(makeHarness({ role: null }).service.assertPublicationWrite('u1', pub()))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(makeHarness({ role: 'owner', orgExists: false }).service.assertPublicationWrite('u1', pub()))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
