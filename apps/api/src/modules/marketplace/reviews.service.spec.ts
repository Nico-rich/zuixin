import { describe, it, expect, vi } from 'vitest';
import { OrganizationRole } from '@prisma/client';
import { ReviewsService } from './reviews.service';
import { AuthorizationService } from '../organizations/authorization.service';
import { MarketplaceAccessService } from './marketplace-access.service';

/**
 * M9-P6 / M10-P6 评审服务单测：评分边界 / upsert 语义（一用户一条）/ 写入即回 pending / moderation 权限与 CAS。
 * 断言重点 = "非法评分绝不落库""非治理角色绝不改审核状态""审核只动 ExtensionReview 表"。
 *
 * 第二段（M10-P6 补强）= **真实治理判定接线**：ReviewsService + 真实 MarketplaceAccessService
 * + 真实 AuthorizationService 矩阵（prisma 只提供假行）——
 * 审核端点"一律走显式治理判定函数"这一契约在此被锁死（member/viewer 即使矩阵未来放宽也 403）。
 */
const ORG = 'org-1';

function pubRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pub-1', organizationId: ORG, userId: 'publisher', extensionId: 'ext-1',
    status: 'published', category: 'knowledge', description: '描述', changelog: null, compatibility: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  };
}

function reviewRow(over: Record<string, unknown> = {}) {
  return {
    id: 'rv-1', publicationId: 'pub-1', userId: 'u2', rating: 5, body: '很好用',
    moderationStatus: 'pending', createdAt: new Date('2026-01-02T00:00:00Z'), ...over,
  };
}

function makeHarness(opts: {
  pub?: unknown; review?: unknown; casCount?: number; manageable?: boolean; moderatable?: boolean;
} = {}) {
  const prisma = {
    extensionPublication: { findUnique: vi.fn(async () => (opts.pub === undefined ? pubRow() : opts.pub)) },
    extensionReview: {
      findUnique: vi.fn(async () => (opts.review === undefined ? null : opts.review)),
      findUniqueOrThrow: vi.fn(async () => (opts.review === undefined ? reviewRow({ moderationStatus: 'approved' }) : opts.review)),
      upsert: vi.fn(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => ({
        ...reviewRow(), ...args.create, ...args.update,
      })),
      findMany: vi.fn(async () => [reviewRow({ id: 'rv-1', moderationStatus: 'approved', userId: 'u2' })]),
      updateMany: vi.fn(async () => ({ count: opts.casCount ?? 1 })),
    },
    user: { findMany: vi.fn(async () => [{ id: 'u2', displayName: '评审者甲' }]) },
  };
  const access = {
    assertVisible: vi.fn(async () => ({
      role: 'owner', platformAdmin: false,
      canManage: opts.manageable ?? true, canModerate: opts.moderatable ?? true,
    })),
    assertModerationRights: vi.fn(async () => 'owner'),
  };
  const audit = { write: vi.fn(async () => undefined) };
  const service = new ReviewsService(prisma as never, access as never, audit as never);
  return { service, prisma, access, audit };
}

describe('ReviewsService（评分 + 审核状态机）', () => {
  it('评分边界：1~5 合法；0/6/2.5/NaN 一律 400 且零写入', async () => {
    const h = makeHarness();
    for (const rating of [1, 5]) {
      await expect(h.service.upsert('u2', 'pub-1', { rating })).resolves.toMatchObject({ rating });
    }
    for (const rating of [0, 6, 2.5, NaN]) {
      const bad = makeHarness();
      await expect(bad.service.upsert('u2', 'pub-1', { rating }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(bad.prisma.extensionReview.upsert).not.toHaveBeenCalled();
    }
  });

  it('upsert：一用户一条（UNIQUE(publicationId,userId) 上的 upsert，不重复计数）', async () => {
    const h = makeHarness();
    await h.service.upsert('u2', 'pub-1', { rating: 4, body: '不错' });
    expect(h.prisma.extensionReview.upsert).toHaveBeenCalledWith({
      where: { publicationId_userId: { publicationId: 'pub-1', userId: 'u2' } },
      create: expect.objectContaining({ publicationId: 'pub-1', userId: 'u2', rating: 4, moderationStatus: 'pending' }),
      update: expect.objectContaining({ rating: 4, moderationStatus: 'pending' }),
    });
  });

  it('upsert：每次写入回到 pending（内容变更必须重新审核，已通过评审改分不自动生效）', async () => {
    const h = makeHarness({ review: reviewRow({ moderationStatus: 'approved' }) });
    const row = await h.service.upsert('u2', 'pub-1', { rating: 1 });
    expect(row.moderationStatus).toBe('pending');
    expect(h.audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'marketplace.review.upsert' }));
  });

  it('upsert：条目不存在 → 404；跨组织未发布条目 → 由 access 抛 404（防枚举）', async () => {
    const missing = makeHarness({ pub: null });
    await expect(missing.service.upsert('u2', 'pub-x', { rating: 5 }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    const hidden = makeHarness();
    hidden.access.assertVisible = vi.fn(async () => { throw Object.assign(new Error('资源不存在'), { code: 'NOT_FOUND' }); });
    await expect(hidden.service.upsert('u2', 'pub-1', { rating: 5 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(hidden.prisma.extensionReview.upsert).not.toHaveBeenCalled();
  });

  it('upsert：仅已上架条目可评分（draft/rejected 一律 400）', async () => {
    for (const status of ['draft', 'rejected']) {
      const h = makeHarness({ pub: pubRow({ status }) });
      await expect(h.service.upsert('u2', 'pub-1', { rating: 5 }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(h.prisma.extensionReview.upsert).not.toHaveBeenCalled();
    }
  });

  it('upsert：发布者本人不得给自己的条目评分（自评刷分防线）→ 403', async () => {
    const h = makeHarness();
    await expect(h.service.upsert('publisher', 'pub-1', { rating: 5 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.prisma.extensionReview.upsert).not.toHaveBeenCalled();
  });

  it('list：默认只列 approved（公开面，pending/rejected 绝不外泄）；显式过滤需审核权', async () => {
    const h = makeHarness();
    const rows = await h.service.list('u2', 'pub-1', {});
    expect(h.prisma.extensionReview.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { publicationId: 'pub-1', moderationStatus: 'approved' },
    }));
    expect(rows[0].reviewer).toEqual({ userId: 'u2', displayName: '评审者甲' });

    const denied = makeHarness({ moderatable: false });
    await expect(denied.service.list('u2', 'pub-1', { moderationStatus: 'pending' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(denied.prisma.extensionReview.findMany).not.toHaveBeenCalled();

    const moderator = makeHarness({ moderatable: true });
    await moderator.service.list('owner-1', 'pub-1', { moderationStatus: 'pending' });
    expect(moderator.prisma.extensionReview.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { publicationId: 'pub-1', moderationStatus: 'pending' },
    }));
  });

  it('moderate：pending→approved（CAS 落库）+ 审计；评审不存在 → 404', async () => {
    const h = makeHarness({ review: reviewRow({ moderationStatus: 'pending' }) });
    const row = await h.service.moderate('owner-1', 'rv-1', { status: 'approved' });
    expect(h.access.assertModerationRights).toHaveBeenCalledTimes(1);
    expect(h.prisma.extensionReview.updateMany).toHaveBeenCalledWith({
      where: { id: 'rv-1', moderationStatus: 'pending' }, data: { moderationStatus: 'approved' },
    });
    expect(row).toMatchObject({ id: 'rv-1' });
    expect(h.audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'marketplace.review.moderate' }));

    const missing = makeHarness({ review: null, pub: null });
    await expect(missing.service.moderate('owner-1', 'rv-x', { status: 'approved' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('moderate：权限不足（access 抛 403/404）→ 状态绝不改变', async () => {
    for (const code of ['FORBIDDEN', 'NOT_FOUND']) {
      const h = makeHarness({ review: reviewRow() });
      h.access.assertModerationRights = vi.fn(async () => { throw Object.assign(new Error('x'), { code }); });
      await expect(h.service.moderate('u2', 'rv-1', { status: 'approved' })).rejects.toMatchObject({ code });
      expect(h.prisma.extensionReview.updateMany).not.toHaveBeenCalled();
      expect(h.audit.write).not.toHaveBeenCalled();
    }
  });

  it('moderate：CAS 失配（并发）→ 400，绝不盲目覆盖', async () => {
    const h = makeHarness({ review: reviewRow(), casCount: 0 });
    await expect(h.service.moderate('owner-1', 'rv-1', { status: 'approved' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('moderate：approved→rejected 可撤销通过（复核边）；同状态重复提交幂等', async () => {
    const h = makeHarness({ review: reviewRow({ moderationStatus: 'approved' }) });
    await h.service.moderate('owner-1', 'rv-1', { status: 'rejected', reason: '内容与事实不符' });
    expect(h.prisma.extensionReview.updateMany).toHaveBeenCalledWith({
      where: { id: 'rv-1', moderationStatus: 'approved' }, data: { moderationStatus: 'rejected' },
    });
    const idem = makeHarness({ review: reviewRow({ moderationStatus: 'approved' }) });
    await expect(idem.service.moderate('owner-1', 'rv-1', { status: 'approved' })).resolves.toBeTruthy();
  });

  it('findMine：回显调用者本人评审（含 pending——让用户看到待审状态）', async () => {
    const h = makeHarness({ review: reviewRow({ moderationStatus: 'pending' }) });
    const mine = await h.service.findMine('u2', 'pub-1');
    expect(mine).toMatchObject({ id: 'rv-1', moderationStatus: 'pending' });
    expect(h.prisma.extensionReview.findUnique).toHaveBeenCalledWith({
      where: { publicationId_userId: { publicationId: 'pub-1', userId: 'u2' } },
    });
  });
});

// ===== M10-P6：审核端点 × 真实治理判定（access / RBAC 矩阵全真实，prisma 为假行）=====
// 哨兵表：审核路径**绝不**写扩展/版本/Agent 物化面（M9-P6 不变量"评分与审核状态不参与授权"的落库侧锁）

function makeWiredHarness(opts: {
  role?: OrganizationRole | null; userRole?: string;
  review?: unknown; casCount?: number;
} = {}) {
  const role = opts.role === undefined ? ('owner' as OrganizationRole) : opts.role;
  const review = opts.review === undefined ? reviewRow({ moderationStatus: 'pending' }) : opts.review;
  const prisma = {
    organization: { findFirst: vi.fn(async () => ({ id: ORG })) },
    organizationMember: { findUnique: vi.fn(async () => (role === null ? null : { role })) },
    user: {
      findUnique: vi.fn(async () => ({ role: opts.userRole ?? 'user' })),
      findMany: vi.fn(async () => [{ id: 'u2', displayName: '评审者甲' }]),
    },
    extensionPublication: { findUnique: vi.fn(async () => pubRow()) },
    extensionReview: {
      findUnique: vi.fn(async () => review),
      findUniqueOrThrow: vi.fn(async () => review),
      findMany: vi.fn(async () => [review]),
      upsert: vi.fn(async () => review),
      updateMany: vi.fn(async () => ({ count: opts.casCount ?? 1 })),
    },
    // 哨兵（审核绝不可写）：任何一次调用即用例失败，失败信息直接点出被污染的物化面
    agent: { update: vi.fn(), updateMany: vi.fn() },
    agentVersion: { update: vi.fn(), updateMany: vi.fn() },
    extension: { update: vi.fn(), updateMany: vi.fn() },
    extensionVersion: { update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
  };
  const auth = new AuthorizationService(prisma as never); // 真实矩阵（can/authorize 均为真实实现）
  const access = new MarketplaceAccessService(prisma as never, auth as never); // 真实治理判定
  const audit = { write: vi.fn(async () => undefined) };
  const service = new ReviewsService(prisma as never, access as never, audit as never);
  return { service, prisma, auth, access, audit };
}

/** 审核后：除 ExtensionReview.moderationStatus 外，绝不写任何物化面 */
function expectModerationWriteSurfaceIsClosed(h: ReturnType<typeof makeWiredHarness>): void {
  for (const [table, spies] of [
    ['agent', h.prisma.agent], ['agentVersion', h.prisma.agentVersion],
    ['extension', h.prisma.extension], ['extensionVersion', h.prisma.extensionVersion],
  ] as const) {
    for (const [method, spy] of Object.entries(spies)) {
      expect(spy, `${table}.${method} 不得被治理动作写入`).not.toHaveBeenCalled();
    }
  }
  expect(h.prisma.extensionReview.upsert).not.toHaveBeenCalled();
}

describe('ReviewsService × 真实治理判定（M10-P6）', () => {
  it('moderate：owner/admin 可审核；member/viewer/非成员一律拒绝且零写入', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const h = makeWiredHarness({ role });
      await expect(h.service.moderate('u-mod', 'rv-1', { status: 'approved' })).resolves.toMatchObject({ id: 'rv-1' });
      expect(h.prisma.extensionReview.updateMany).toHaveBeenCalledTimes(1);
      expectModerationWriteSurfaceIsClosed(h);
    }
    for (const role of ['member', 'viewer'] as const) {
      const h = makeWiredHarness({ role });
      await expect(h.service.moderate('u-mod', 'rv-1', { status: 'approved' }))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(h.prisma.extensionReview.updateMany).not.toHaveBeenCalled();
      expect(h.audit.write).not.toHaveBeenCalled();
      expectModerationWriteSurfaceIsClosed(h);
    }
    // 非成员 → 404（防枚举：不得暴露评审/条目存在性）
    const outsider = makeWiredHarness({ role: null });
    await expect(outsider.service.moderate('u-out', 'rv-1', { status: 'approved' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(outsider.prisma.extensionReview.updateMany).not.toHaveBeenCalled();
    // 平台管理员（非成员）→ 逃生门放行
    const platform = makeWiredHarness({ role: null, userRole: 'admin' });
    await expect(platform.service.moderate('u-admin', 'rv-1', { status: 'approved' })).resolves.toMatchObject({ id: 'rv-1' });
  });

  it('moderate：**只**改 moderationStatus 字段（评分/物化面逐项不变——M9-P6 不变量）', async () => {
    for (const [rating, target] of [[5, 'approved'], [1, 'rejected']] as const) {
      const h = makeWiredHarness({ role: 'owner', review: reviewRow({ rating, moderationStatus: 'pending' }) });
      await h.service.moderate('u-mod', 'rv-1', { status: target });
      // 落库 payload 精确等于"状态条件更新"：不含 rating/body，也不含任何其他表
      expect(h.prisma.extensionReview.updateMany).toHaveBeenCalledWith({
        where: { id: 'rv-1', moderationStatus: 'pending' },
        data: { moderationStatus: target },
      });
      expectModerationWriteSurfaceIsClosed(h);
    }
  });

  it('list：pending/rejected 过滤需治理权（真实判定）；approved 公开面任何成员可读', async () => {
    for (const role of ['member', 'viewer'] as const) {
      const h = makeWiredHarness({ role });
      await expect(h.service.list('u-x', 'pub-1', { moderationStatus: 'pending' }))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(h.prisma.extensionReview.findMany).not.toHaveBeenCalled();
    }
    const owner = makeWiredHarness({ role: 'owner' });
    await expect(owner.service.list('u-owner', 'pub-1', { moderationStatus: 'pending' })).resolves.toHaveLength(1);
    expect(owner.prisma.extensionReview.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { publicationId: 'pub-1', moderationStatus: 'pending' },
    }));
    const member = makeWiredHarness({ role: 'member' });
    await expect(member.service.list('u-member', 'pub-1', {})).resolves.toHaveLength(1);
    expect(member.prisma.extensionReview.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { publicationId: 'pub-1', moderationStatus: 'approved' },
    }));
  });
});
