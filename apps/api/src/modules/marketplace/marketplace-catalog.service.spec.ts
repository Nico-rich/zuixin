import { describe, it, expect, vi } from 'vitest';
import { MarketplaceCatalogService } from './marketplace-catalog.service';
import { ExtensionManifest } from '../extensions/manifest';

/**
 * M9-P6 目录服务单测：检索（状态/分类/关键词/分页）+ 聚合投影（评分/安装量/发布者/权限披露）。
 * 断言重点 = "非公开面必须带 organizationId 且过成员校验（防枚举）""聚合是只读投影且与授权无关"。
 */
const SLUG = 'mkt-agent';
const REGISTRY: Record<string, { permission: string }> = {
  'knowledge.search': { permission: 'read' },
  'external.action': { permission: 'external_action' },
};

function extRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ext-1', organizationId: 'org-1', ownerUserId: 'u1', name: '品牌助手扩展', slug: SLUG,
    description: '组织私有的品牌助手', kind: 'agent', status: 'published',
    createdAt: new Date(), updatedAt: new Date(), ...over,
  };
}

function manifestOf(): ExtensionManifest {
  return {
    manifestVersion: 1, kind: 'agent', permissions: ['agent.run'],
    agent: {
      name: 'brand-agent', description: 'd',
      systemPrompt: '你是 {{extension.name}}',
      tools: ['knowledge.search', 'external.action'],
    },
  } as unknown as ExtensionManifest;
}

function versionRow() {
  return {
    id: 'v1', extensionId: 'ext-1', version: 2, status: 'published', manifest: manifestOf(),
    checksum: 'a'.repeat(64), signature: 'b'.repeat(64), createdAt: new Date('2026-01-01T00:00:00Z'),
    permissions: [
      { id: 'p1', versionId: 'v1', name: 'agent.run', scope: 'organization', description: '运行扩展 Agent' },
    ],
  };
}

function pubRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pub-1', organizationId: 'org-1', userId: 'u1', extensionId: 'ext-1', status: 'published',
    category: 'knowledge', description: '品牌问答助手（只读检索）', changelog: [{ version: '2.0.0', notes: '优化检索' }],
    compatibility: { minPlatformVersion: '1.0.0' },
    createdAt: new Date('2026-01-02T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'), ...over,
  };
}

function makeHarness(opts: {
  rows?: unknown[]; total?: number; ext?: unknown; version?: unknown; detailRow?: unknown;
  ratingGroups?: unknown[]; installGroups?: unknown[]; categoryGroups?: unknown[]; reviewVisible?: boolean;
} = {}) {
  const rows = opts.rows ?? [pubRow()];
  const prisma = {
    extensionPublication: {
      findMany: vi.fn(async () => rows),
      count: vi.fn(async () => opts.total ?? rows.length),
      findUnique: vi.fn(async () => (opts.detailRow === undefined ? pubRow() : opts.detailRow)),
      groupBy: vi.fn(async () => opts.categoryGroups ?? [{ category: 'knowledge', _count: { _all: 2 } }]),
    },
    extension: { findMany: vi.fn(async () => [opts.ext === undefined ? extRow() : opts.ext].filter(Boolean)) },
    extensionVersion: { findMany: vi.fn(async () => (opts.version === undefined ? [versionRow()] : [opts.version].filter(Boolean))) },
    organization: { findMany: vi.fn(async () => [{ id: 'org-1', name: '发布者组织', slug: 'publisher-org' }]) },
    user: { findMany: vi.fn(async () => [{ id: 'u1', displayName: '发布者甲' }, { id: 'u2', displayName: '评审者乙' }]) },
    extensionReview: {
      groupBy: vi.fn(async () => opts.ratingGroups ?? [
        { publicationId: 'pub-1', rating: 5, _count: { _all: 2 } },
        { publicationId: 'pub-1', rating: 3, _count: { _all: 1 } },
      ]),
    },
    extensionInstallation: {
      groupBy: vi.fn(async () => opts.installGroups ?? [{ extensionId: 'ext-1', _count: { _all: 4 } }]),
    },
  };
  const access = {
    requireRead: vi.fn(async () => 'owner'),
    assertVisible: vi.fn(async () => ({
      role: 'member', platformAdmin: false, canManage: false, canModerate: opts.reviewVisible ?? false,
    })),
  };
  const reviews = {
    listApproved: vi.fn(async () => [
      { id: 'rv-1', publicationId: 'pub-1', userId: 'u2', rating: 5, body: '很好用', moderationStatus: 'approved', createdAt: new Date(), reviewer: { userId: 'u2', displayName: '评审者乙' } },
    ]),
    findMine: vi.fn(async () => null),
  };
  const registry = { get: vi.fn((name: string) => REGISTRY[name]) };
  const service = new MarketplaceCatalogService(prisma as never, access as never, reviews as never, registry as never);
  return { service, prisma, access, reviews, registry };
}

describe('MarketplaceCatalogService（检索 + 聚合）', () => {
  it('检索：默认仅 published（公开面）+ 分页 skip/take/totalPages 计算正确', async () => {
    const h = makeHarness({ total: 41 });
    const page = await h.service.search('u9', { page: 2, limit: 20 });
    expect(h.prisma.extensionPublication.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'published' }, skip: 20, take: 20,
    }));
    expect(page).toMatchObject({ total: 41, page: 2, limit: 20, totalPages: 3 });
    expect(h.access.requireRead).not.toHaveBeenCalled(); // 公开面无需组织 scope
  });

  it('检索：非公开状态（draft/rejected/all）必须给 organizationId 且过 agent.read（防跨组织枚举）', async () => {
    const noOrg = makeHarness();
    for (const status of ['draft', 'rejected', 'all'] as const) {
      await expect(noOrg.service.search('u9', { status })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(noOrg.prisma.extensionPublication.findMany).not.toHaveBeenCalled();

    const scoped = makeHarness();
    await scoped.service.search('u9', { status: 'all', organizationId: 'org-1' });
    expect(scoped.access.requireRead).toHaveBeenCalledWith('u9', 'org-1');
    expect(scoped.prisma.extensionPublication.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: 'org-1' }, // 'all' 不加状态谓词
    }));

    const drafts = makeHarness();
    await drafts.service.search('u9', { status: 'draft', organizationId: 'org-1' });
    expect(drafts.prisma.extensionPublication.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: 'org-1', status: 'draft' },
    }));
  });

  it('检索：权限不足（access 抛 403）→ 零查询（绝不先查后判）', async () => {
    const h = makeHarness();
    h.access.requireRead = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'FORBIDDEN' }); });
    await expect(h.service.search('u9', { status: 'draft', organizationId: 'org-x' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.prisma.extensionPublication.findMany).not.toHaveBeenCalled();
  });

  it('检索：关键词先有界解析命中扩展 id，再按描述或 extensionId 命中', async () => {
    const h = makeHarness();
    await h.service.search('u9', { q: '品牌' });
    expect(h.prisma.extension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 500,
      where: { OR: expect.arrayContaining([{ name: { contains: '品牌', mode: 'insensitive' } }]) },
    }));
    const [args] = h.prisma.extensionPublication.findMany.mock.calls[0] as unknown as [{ where: { OR: unknown[] } }];
    expect(args.where.OR).toEqual([
      { description: { contains: '品牌', mode: 'insensitive' } },
      { extensionId: { in: ['ext-1'] } },
    ]);
  });

  it('检索：分类过滤（白名单外 400——服务层二次防御，不依赖 zod）', async () => {
    const h = makeHarness();
    await h.service.search('u9', { category: 'knowledge' });
    expect(h.prisma.extensionPublication.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'published', category: 'knowledge' },
    }));
    await expect(h.service.search('u9', { category: 'malware' as never }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('聚合：评分仅计 approved（均值/条数/分布）、安装量取既有表计数、发布者信息只回显 displayName', async () => {
    const h = makeHarness();
    const { items } = await h.service.search('u9', {});
    const item = items[0];
    expect(item.rating).toMatchObject({ average: 4.33, count: 3 });
    expect(item.rating.distribution).toEqual({ 1: 0, 2: 0, 3: 1, 4: 0, 5: 2 });
    expect(item.installCount).toBe(4);
    expect(item.publisher).toEqual({
      organizationId: 'org-1', organizationName: '发布者组织', organizationSlug: 'publisher-org',
      userId: 'u1', displayName: '发布者甲',
    });
    // 评分查询口径：仅 approved
    expect(h.prisma.extensionReview.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: { publicationId: { in: ['pub-1'] }, moderationStatus: 'approved' },
      by: ['publicationId', 'rating'],
    }));
    // manifest 本体绝不整体回显（只回显校验证据 + 权限披露）
    expect(item.publishedVersion).toEqual({ id: 'v1', version: 2, checksum: 'a'.repeat(64), createdAt: new Date('2026-01-01T00:00:00Z') });
    expect(JSON.stringify(item)).not.toContain('systemPrompt');
  });

  it('聚合：权限披露现算 F4 交集（external_action 被剔除），且不含任何评分/安装量字段', async () => {
    const h = makeHarness();
    const { items } = await h.service.search('u9', {});
    const disclosure = items[0].permissionDisclosure!;
    expect(disclosure.readOnly).toBe(true);
    expect(disclosure.requestedTools).toEqual(['knowledge.search', 'external.action']);
    expect(disclosure.effectiveTools).toEqual(['knowledge.search']);
    expect(disclosure.droppedTools.map((d) => d.reason)).toEqual(['tool_permission_not_wrappable']);
    expect(disclosure.declaredPermissions[0]).toMatchObject({ name: 'agent.run', scope: 'organization' });
  });

  it('聚合：历史脏数据（扩展/版本行已删）→ 回显 null/零值，读路径绝不 500', async () => {
    const h = makeHarness({ ext: null, version: null, installGroups: [] });
    const { items } = await h.service.search('u9', {});
    expect(items[0].extension).toBeNull();
    expect(items[0].permissionDisclosure).toBeNull();
    expect(items[0].installCount).toBe(0);
    expect(items[0].rating).toMatchObject({ average: 4.33 });
  });

  it('空结果：不触达聚合查询（early return，读路径有界）', async () => {
    const h = makeHarness({ rows: [], total: 0 });
    const page = await h.service.search('u9', {});
    expect(page).toMatchObject({ items: [], total: 0, totalPages: 0 });
    expect(h.prisma.extensionVersion.findMany).not.toHaveBeenCalled();
    expect(h.prisma.extensionReview.groupBy).not.toHaveBeenCalled();
  });

  it('详情：不存在 → 404；存在 → 回显评审 + 查看者能力 + 本人评审', async () => {
    const missing = makeHarness({ detailRow: null });
    await expect(missing.service.detail('u9', 'pub-x')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const h = makeHarness();
    const detail = await h.service.detail('u9', 'pub-1');
    expect(h.access.assertVisible).toHaveBeenCalledTimes(1);
    expect(detail.reviews).toHaveLength(1);
    expect(detail.reviews[0].reviewer.displayName).toBe('评审者乙');
    expect(detail.viewer).toMatchObject({ role: 'member', canManage: false, canModerate: false, myReview: null });
  });

  it('详情：未发布跨组织 → access 抛 404（防枚举，响应零字段泄漏）', async () => {
    const h = makeHarness({ detailRow: pubRow({ status: 'draft', description: '机密草稿描述' }) });
    h.access.assertVisible = vi.fn(async () => { throw Object.assign(new Error('资源不存在'), { code: 'NOT_FOUND' }); });
    await expect(h.service.detail('u9', 'pub-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.prisma.extensionVersion.findMany).not.toHaveBeenCalled();
  });

  it('分类：白名单全集按序回显 + 已上架计数（无计数=0）', async () => {
    const h = makeHarness();
    const categories = await h.service.categories();
    expect(categories.map((c) => c.category)).toContain('knowledge');
    expect(categories.find((c) => c.category === 'knowledge')?.publishedCount).toBe(2);
    expect(categories.find((c) => c.category === 'finance')?.publishedCount).toBe(0);
    expect(h.prisma.extensionPublication.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['category'], where: { status: 'published' },
    }));
  });
});
