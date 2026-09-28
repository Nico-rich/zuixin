import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { AuthorizationService } from '../organizations/authorization.service';
import { MarketplaceAccessService, PublicationScopeRow } from './marketplace-access.service';
import { MODERATION_PERMISSION } from './marketplace-moderation';

/**
 * M10-P6 / M11-P12 归属/治理裁决单测（e2e 之外 access 服务的直接覆盖层）。
 *
 * 关键断言：
 * ① 治理裁决走**治理位判定**（`marketplace.moderate`，M11-P12 专用位），**绝不**借
 *    `auth.authorize(..., 'member.write')` 的权限位抛错路径；
 * ② tripwire 新口径：member 获得**旧借用位** member.write **不**改变治理权（仍 403）；
 *    member 获得**专用位** marketplace.moderate **才**改变（放行）+ 漂移告警 leaked=[member]；
 * ③ 专用位收紧（治理角色失去该位）→ 治理权随之收紧（403，fail-closed）；漂移告警（missing）；
 * ④ 防枚举口径不变（非成员 404 / 成员未持治理位 403）；viewer 能力与裁决同源（无口径分叉）。
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

/**
 * 矩阵改动模拟：把 `action` 位授予全部角色（裁决/审计都读注入的 `auth.can`，故此处即"矩阵被改"）。
 */
function grantToAll(auth: AuthorizationService, action: string): void {
  const original = auth.can.bind(auth);
  vi.spyOn(auth, 'can').mockImplementation((r, a) => (a === action ? true : original(r, a)));
}

/** 矩阵改动模拟：从全部角色撤走 `action` 位 */
function revokeFromAll(auth: AuthorizationService, action: string): void {
  const original = auth.can.bind(auth);
  vi.spyOn(auth, 'can').mockImplementation((r, a) => (a === action ? false : original(r, a)));
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

  it('① 治理裁决按治理位裁决：不经 auth.authorize（抛错路径），但确实读 marketplace.moderate', async () => {
    const h = makeHarness({ role: 'owner' });
    const authorizeSpy = vi.spyOn(h.auth, 'authorize');
    const canSpy = vi.spyOn(h.auth, 'can');
    await h.service.assertModerationRights('u1', pub());
    expect(authorizeSpy).not.toHaveBeenCalled();
    // 治理位被真正消费（M11-P12：放行来自 marketplace.moderate，而非角色硬编码）
    expect(canSpy).toHaveBeenCalledWith('owner', MODERATION_PERMISSION);
    // 对照：发布者写权仍走权限位抛错路径（未被本 Phase 改动）
    await h.service.assertPublicationWrite('u1', pub());
    expect(authorizeSpy).toHaveBeenCalledWith('u1', ORG, 'agent.write');
  });

  it('② tripwire：member 获**旧借用位** member.write → 仍 403（该位已与治理彻底解耦）', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const h = makeHarness({ role: 'member' });
    expect(h.auth.can('member', 'member.write')).toBe(false); // 当前矩阵事实
    grantToAll(h.auth, 'member.write');
    expect(h.auth.can('member', 'member.write')).toBe(true); // 模拟矩阵改动
    await expect(h.service.assertModerationRights('u1', pub()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(warn).not.toHaveBeenCalled(); // 旧位与治理位无关 → 审计不一致都不发生
  });

  it('② tripwire：member 获**专用位** marketplace.moderate → 放行（显式授权改变治理权）+ 漂移告警', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const h = makeHarness({ role: 'member' });
    grantToAll(h.auth, MODERATION_PERMISSION);
    await expect(h.service.assertModerationRights('u1', pub())).resolves.toBe('member');
    // 同一改动必须被审计暴露（leaked=member/viewer）→ 单测（真实矩阵）同时变红强制人工复核
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaked=[member,viewer]'));
  });

  it('③ 专用位收紧（治理角色失去该位）→ 治理权随之收紧（fail-closed，绝不越权放行）+ 漂移告警', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const h = makeHarness({ role: 'admin' });
    revokeFromAll(h.auth, MODERATION_PERMISSION);
    await expect(h.service.assertModerationRights('u1', pub()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing=[owner,admin]'));

    // 当前矩阵一致 → 无告警（本用例同时锁定"仅漂移才告警"）
    warn.mockClear();
    const clean = makeHarness({ role: 'admin' });
    await expect(clean.service.assertModerationRights('u1', pub())).resolves.toBe('admin');
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
    // 旧借用位放宽 → 回显口径同样不放宽（否则前端会显示"可审核"但请求 403）
    const oldBit = makeHarness({ role: 'member' });
    grantToAll(oldBit.auth, 'member.write');
    const oldCaps = await oldBit.service.assertVisible('u1', pub());
    expect(oldCaps).toMatchObject({ canModerate: false });
    // 专用位显式授予 → 回显与裁决**同源**放宽（口径分叉在这两个方向上都被本用例挡住）
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); // 该矩阵必然漂移告警
    const granted = makeHarness({ role: 'member' });
    grantToAll(granted.auth, MODERATION_PERMISSION);
    const caps = await granted.service.assertVisible('u1', pub());
    expect(caps).toMatchObject({ canModerate: true });
    await expect(granted.service.assertModerationRights('u1', pub())).resolves.toBe('member');
    warn.mockRestore();
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

  it('⑧ M10-P15（BUG-13）文案级存在性 oracle：非成员 404 必须复用调用方"行不存在"的文案', async () => {
    // 调用方（publications/reviews/catalog）先按 id 取行：取不到 → 404「发布条目不存在」。
    // 若此处非成员 404 用另一套文案（"资源不存在"），跨租户者即可凭**错误文案**逐字区分
    // "条目不存在"与"条目存在但我不属该组织" —— 存在性 oracle，使 404 折叠形同虚设。
    const MESSAGE = '发布条目不存在';
    for (const method of ['assertPublicationWrite', 'assertModerationRights'] as const) {
      await expect(makeHarness({ role: null }).service[method]('u-x', pub(), MESSAGE))
        .rejects.toMatchObject({ code: 'NOT_FOUND', message: MESSAGE });
    }
    // 未发布条目（可见性路径）同一口径
    await expect(makeHarness({ role: null }).service.assertVisible('u-x', pub({ status: 'draft' }), MESSAGE))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: MESSAGE });
    // 缺省仍为通用文案（无调用方指定时不留空文案）
    await expect(makeHarness({ role: null }).service.assertPublicationWrite('u-x', pub()))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: '资源不存在' });
    // 有成员身份的路径不受影响（合法成员照常放行/按权限位裁决）
    await expect(makeHarness({ role: 'owner' }).service.assertPublicationWrite('u1', pub(), MESSAGE)).resolves.toBe('owner');
  });
});
