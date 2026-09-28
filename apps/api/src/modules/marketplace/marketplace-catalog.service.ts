/**
 * M9-P6 市场目录（检索 + 聚合投影 + 权限披露）。
 *
 * 读路径口径：
 * - **公开面**：`status='published'`（默认）对任何已登录用户可见；
 * - **私有面**：`draft/rejected/all` 必须显式给 `organizationId` 且为该组织成员（`agent.read`）——
 *   否则 400/403；详情页对跨组织的未发布条目返回 404（防枚举，见 MarketplaceAccessService.assertVisible）；
 * - 关键词命中扩展 name/slug/description 时先解析扩展 id（**有界扫描** KEYWORD_EXTENSION_SCAN_LIMIT），
 *   再按条目 description 或 extensionId 命中——绝不无界扫表；
 * - 聚合**全部为只读投影，不新建事实表**：
 *   评分 ← `ExtensionReview`（仅 approved；按 rating 分组计数）；
 *   安装量 ← `ExtensionInstallation` 行数（既有表计数，已安装即计数，与启停无关）；
 *   权限披露 ← 扩展 manifest（声明）+ 平台工具注册表（现算交集，唯一实现 `buildPermissionDisclosure`）。
 *
 * **聚合数据绝不参与授权**：rating / installCount / moderationStatus 都不流入任何权限判定
 * （权限 = manifest ∩ 平台白名单 ∩ 组织策略；见 permission-disclosure.ts 与 F4 语义）。
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ToolRegistry } from '../../core/tools/tool-registry.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { ExtensionKind, ExtensionManifest } from '../extensions/manifest';
import { MarketplaceAccessService, ViewerCapabilities } from './marketplace-access.service';
import { ReviewsService, ReviewView, ReviewRow } from './reviews.service';
import {
  DEFAULT_PAGE_SIZE, KEYWORD_EXTENSION_SCAN_LIMIT, MARKETPLACE_CATEGORIES, PublicationStatus,
  REVIEW_PREVIEW_LIMIT, isMarketplaceCategory,
} from './marketplace-status';
import { RatingSummary, summarizeRatingDistribution } from './rating-summary';
import { PermissionDisclosure, buildPermissionDisclosure } from './permission-disclosure';
import { ListPublicationsDto } from './marketplace.dto';

export interface PublicationPublisher {
  organizationId: string;
  organizationName: string | null;
  organizationSlug: string | null;
  /** 条目创建者（公开署名：displayName 可为 null；**绝不回显邮箱**） */
  userId: string;
  displayName: string | null;
}

export interface PublicationExtensionRef {
  id: string;
  name: string;
  slug: string;
  kind: string;
  /** platform = 平台级扩展（organizationId=null）；organization = 组织私有 */
  scope: 'platform' | 'organization';
  description: string | null;
  status: string;
}

export interface PublicationPublishedVersion {
  id: string;
  version: number;
  checksum: string;
  createdAt: Date;
}

export interface PublicationListItem {
  id: string;
  status: PublicationStatus;
  category: string;
  description: string;
  changelog: unknown;
  compatibility: unknown;
  createdAt: Date;
  updatedAt: Date;
  publisher: PublicationPublisher;
  extension: PublicationExtensionRef | null;
  /** 上架时锁定的已发布版本（manifest 不整体回显——只回显校验证据与权限披露） */
  publishedVersion: PublicationPublishedVersion | null;
  rating: RatingSummary;
  installCount: number;
  permissionDisclosure: PermissionDisclosure | null;
}

export interface PublicationDetail extends PublicationListItem {
  reviews: ReviewView[];
  viewer: ViewerCapabilities & { myReview: ReviewRow | null };
}

export interface PublicationSearchResult {
  items: PublicationListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

type PublicationDbRow = Prisma.ExtensionPublicationGetPayload<Record<string, never>>;

@Injectable()
export class MarketplaceCatalogService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MarketplaceAccessService) private readonly access: MarketplaceAccessService,
    @Inject(ReviewsService) private readonly reviews: ReviewsService,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
  ) {}

  /** 分类白名单 + 已上架条目数（Web 过滤器数据源；纯只读投影） */
  async categories(): Promise<{ category: string; publishedCount: number }[]> {
    const grouped = await this.prisma.extensionPublication.groupBy({
      by: ['category'], where: { status: 'published' }, _count: { _all: true },
    });
    const counts = new Map(grouped.map((g) => [g.category, g._count._all]));
    return MARKETPLACE_CATEGORIES.map((category) => ({ category, publishedCount: counts.get(category) ?? 0 }));
  }

  /** 目录检索（分类/关键词/状态过滤 + 分页） */
  async search(userId: string, dto: ListPublicationsDto): Promise<PublicationSearchResult> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    const status = dto.status ?? 'published';
    const where: Prisma.ExtensionPublicationWhereInput = {};

    if (status === 'published') {
      where.status = 'published';
      // 公开面：organizationId 仅作为过滤器（内容本就公开，无需成员身份）
      if (dto.organizationId) where.organizationId = dto.organizationId;
    } else {
      // 私有面（draft/rejected/all）：必须显式组织 scope + 成员身份 + agent.read
      if (!dto.organizationId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, '查看未上架条目必须提供 organizationId');
      }
      await this.access.requireRead(userId, dto.organizationId);
      where.organizationId = dto.organizationId;
      if (status !== 'all') where.status = status;
    }

    if (dto.category) {
      if (!isMarketplaceCategory(dto.category)) throw new AppError(ErrorCode.VALIDATION_ERROR, '分类不在白名单内');
      where.category = dto.category;
    }

    if (dto.q) {
      const keyword = dto.q;
      const matched = await this.prisma.extension.findMany({
        where: {
          OR: [
            { name: { contains: keyword, mode: 'insensitive' } },
            { slug: { contains: keyword, mode: 'insensitive' } },
            { description: { contains: keyword, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
        take: KEYWORD_EXTENSION_SCAN_LIMIT,
      });
      where.OR = [
        { description: { contains: keyword, mode: 'insensitive' } },
        { extensionId: { in: matched.map((e) => e.id) } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.extensionPublication.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.extensionPublication.count({ where }),
    ]);
    const items = await this.hydrate(rows);
    return { items, total, page, limit, totalPages: limit > 0 ? Math.ceil(total / limit) : 0 };
  }

  /** 详情（含评审回显与查看者能力——只读展示，不参与授权判定） */
  async detail(userId: string, id: string): Promise<PublicationDetail> {
    const row = await this.prisma.extensionPublication.findUnique({ where: { id } });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, '发布条目不存在');
    const viewer = await this.access.assertVisible(userId, row, '发布条目不存在');
    const [item] = await this.hydrate([row]);
    const [reviews, myReview] = await Promise.all([
      this.reviews.listApproved(id, REVIEW_PREVIEW_LIMIT),
      this.reviews.findMine(userId, id),
    ]);
    return { ...item, reviews, viewer: { ...viewer, myReview } };
  }

  // ===== 聚合投影 =====

  /**
   * 批量补齐（**每页固定 6 次查询**，与条目数无关——绝不 N+1）。
   * 缺失行（扩展被删等历史脏数据）一律回显 null / 零值，绝不抛错（读路径绝不因脏数据 500）。
   */
  private async hydrate(rows: PublicationDbRow[]): Promise<PublicationListItem[]> {
    if (!rows.length) return [];
    const publicationIds = rows.map((r) => r.id);
    const extensionIds = [...new Set(rows.map((r) => r.extensionId))];
    const organizationIds = [...new Set(rows.map((r) => r.organizationId))];
    const userIds = [...new Set(rows.map((r) => r.userId))];

    const [extensions, versions, organizations, users, ratingGroups, installGroups] = await Promise.all([
      this.prisma.extension.findMany({ where: { id: { in: extensionIds } } }),
      this.prisma.extensionVersion.findMany({
        where: { extensionId: { in: extensionIds }, status: 'published' },
        include: { permissions: true },
        orderBy: { version: 'desc' },
      }),
      this.prisma.organization.findMany({
        where: { id: { in: organizationIds } }, select: { id: true, name: true, slug: true },
      }),
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }),
      this.prisma.extensionReview.groupBy({
        by: ['publicationId', 'rating'],
        where: { publicationId: { in: publicationIds }, moderationStatus: 'approved' },
        _count: { _all: true },
      }),
      this.prisma.extensionInstallation.groupBy({
        by: ['extensionId'], where: { extensionId: { in: extensionIds } }, _count: { _all: true },
      }),
    ]);

    const extById = new Map(extensions.map((e) => [e.id, e]));
    const versionByExt = new Map<string, (typeof versions)[number]>();
    for (const v of versions) if (!versionByExt.has(v.extensionId)) versionByExt.set(v.extensionId, v); // orderBy desc → 首见即最新
    const orgById = new Map(organizations.map((o) => [o.id, o]));
    const userById = new Map(users.map((u) => [u.id, u]));
    const installsByExt = new Map(installGroups.map((g) => [g.extensionId, g._count._all]));
    const ratingsByPub = new Map<string, { rating: number; count: number }[]>();
    for (const g of ratingGroups) {
      const list = ratingsByPub.get(g.publicationId) ?? [];
      list.push({ rating: g.rating, count: g._count._all });
      ratingsByPub.set(g.publicationId, list);
    }

    return rows.map((row) => {
      const ext = extById.get(row.extensionId) ?? null;
      const version = versionByExt.get(row.extensionId) ?? null;
      const org = orgById.get(row.organizationId) ?? null;
      const user = userById.get(row.userId) ?? null;
      const manifest = (version?.manifest ?? null) as unknown as ExtensionManifest | null;
      const disclosure = version && manifest
        ? buildPermissionDisclosure({
          kind: (ext?.kind ?? manifest.kind) as ExtensionKind,
          manifest,
          declaredPermissions: version.permissions.map((p) => ({ name: p.name as never, scope: p.scope, description: p.description })),
          lookup: (name) => this.registry.get(name),
        })
        : null;
      return {
        id: row.id,
        status: row.status as PublicationStatus,
        category: row.category,
        description: row.description,
        changelog: row.changelog,
        compatibility: row.compatibility,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        publisher: {
          organizationId: row.organizationId,
          organizationName: org?.name ?? null,
          organizationSlug: org?.slug ?? null,
          userId: row.userId,
          displayName: user?.displayName ?? null,
        },
        extension: ext
          ? {
            id: ext.id, name: ext.name, slug: ext.slug, kind: ext.kind,
            scope: ext.organizationId ? 'organization' : 'platform',
            description: ext.description, status: ext.status,
          }
          : null,
        publishedVersion: version
          ? { id: version.id, version: version.version, checksum: version.checksum, createdAt: version.createdAt }
          : null,
        rating: summarizeRatingDistribution(ratingsByPub.get(row.id) ?? []),
        installCount: installsByExt.get(row.extensionId) ?? 0,
        permissionDisclosure: disclosure,
      } satisfies PublicationListItem;
    });
  }
}
