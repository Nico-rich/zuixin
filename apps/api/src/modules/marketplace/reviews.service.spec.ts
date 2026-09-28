import { describe, it, expect, vi } from 'vitest';
import { ReviewsService } from './reviews.service';

/**
 * M9-P6 评审服务单测：评分边界 / upsert 语义（一用户一条）/ 写入即回 pending / moderation 权限与 CAS。
 * 断言重点 = "非法评分绝不落库""非 owner/admin 绝不改审核状态""审核只动 ExtensionReview 表"。
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
