/**
 * M9-P6 评审服务（评分 1~5 / UNIQUE(publicationId,userId) upsert / moderation 状态机）。
 *
 * 规则（与设计文档逐字一致）：
 * - 评分 1~5 整数：zod 初筛 + `isValidRating` 服务层复核（同一口径两处断言，见单测）；
 * - 一用户一条目**一条**评审：`@@unique([publicationId, userId])` 上的 upsert（重复提交 = 覆盖，绝不重复计数）；
 * - 任何写入（含首次打分与后续改分/改评语）一律回到 `pending`——**审核是计入公开聚合的前置门禁**；
 * - moderation 仅发布者组织 **owner/admin** 或平台管理员——**M10-P6 起为显式判定**
 *   （`marketplace-moderation.ts` 的 `MODERATION_ROLES`，不再借用 `member.write` 的隐式推论）；
 *   `moderate` 与 `list`（pending/rejected 过滤）一律经 `access.assertModerationRights` 裁决；
 *   非成员 → 404 防枚举，成员但权限不足（member/viewer）→ 403；
 * - 状态机 pending→approved|rejected、approved↔rejected（同状态重复提交幂等），**pending 永不可被设**；
 * - 评分**绝不提升权限**：本服务只写 ExtensionReview 表；扩展权限恒由 M8-P6 物化路径决定
 *   （e2e 断言：同一扩展在 1 星与 5 星下 effectiveTools 与安装后 Agent.tools 完全一致）。
 */

import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { MarketplaceAccessService, PublicationScopeRow } from './marketplace-access.service';
import { ListReviewsDto, ModerateReviewDto, UpsertReviewDto } from './marketplace.dto';
import {
  REVIEW_PREVIEW_LIMIT, ReviewModerationStatus, assertModerationTransition, isValidRating,
} from './marketplace-status';

/** 评审行投影（单测可注入纯对象） */
export interface ReviewRow {
  id: string;
  publicationId: string;
  userId: string;
  rating: number;
  body: string | null;
  moderationStatus: string;
  createdAt: Date;
}

export interface ReviewView extends ReviewRow {
  reviewer: { userId: string; displayName: string | null };
}

@Injectable()
export class ReviewsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MarketplaceAccessService) private readonly access: MarketplaceAccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * 打分/改分（upsert：一用户一条目一条评审）。
   * 每次写入一律回到 pending（内容变更必须重新审核——已通过评审改分不会自动生效）。
   */
  async upsert(userId: string, publicationId: string, dto: UpsertReviewDto): Promise<ReviewRow> {
    if (!isValidRating(dto.rating)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '评分必须是 1~5 的整数');
    }
    const pub = await this.requirePublication(publicationId);
    await this.access.assertVisible(userId, pub); // 未发布条目跨组织 → 404 防枚举
    if (pub.status !== 'published') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '仅已上架的发布条目可评分');
    }
    if (pub.userId === userId) {
      throw new AppError(ErrorCode.FORBIDDEN, '不得给自己的发布条目评分'); // 自评刷分防线
    }
    const row = await this.prisma.extensionReview.upsert({
      where: { publicationId_userId: { publicationId, userId } },
      create: { publicationId, userId, rating: dto.rating, body: dto.body ?? null, moderationStatus: 'pending' },
      // 覆盖语义：body 省略即清空（与 DTO 的 strictObject 一起构成"整体替换"契约）
      update: { rating: dto.rating, body: dto.body ?? null, moderationStatus: 'pending' },
    });
    await this.writeAudit(userId, pub.organizationId, 'marketplace.review.upsert', row.id, {
      publicationId, rating: row.rating, moderationStatus: row.moderationStatus,
    });
    return row as ReviewRow;
  }

  /**
   * 列出评审：默认只列 approved（公开面）；显式请求 pending/rejected 需治理权
   * （owner/admin 或平台管理员；capabilities 与裁决同源，见 MarketplaceAccessService.assertVisible）。
   */
  async list(userId: string, publicationId: string, dto: ListReviewsDto): Promise<ReviewView[]> {
    const pub = await this.requirePublication(publicationId);
    const caps = await this.access.assertVisible(userId, pub);
    const filter = dto.moderationStatus;
    if (filter && filter !== 'approved' && !caps.canModerate) {
      throw new AppError(ErrorCode.FORBIDDEN, '仅组织 owner/admin 可查看待审/已驳回评审');
    }
    const rows = await this.prisma.extensionReview.findMany({
      where: { publicationId, moderationStatus: filter ?? 'approved' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: dto.limit ?? REVIEW_PREVIEW_LIMIT,
    });
    return this.attachReviewers(rows as ReviewRow[]);
  }

  /** 审核：pending→approved|rejected；approved↔rejected；同状态重复提交幂等（CAS 落库） */
  async moderate(userId: string, reviewId: string, dto: ModerateReviewDto): Promise<ReviewRow> {
    const review = await this.prisma.extensionReview.findUnique({ where: { id: reviewId } });
    if (!review) throw new AppError(ErrorCode.NOT_FOUND, '评审不存在');
    const pub = await this.requirePublication(review.publicationId);
    await this.access.assertModerationRights(userId, pub); // 治理显式判定：非成员 404 / member|viewer 403
    const current = review.moderationStatus as ReviewModerationStatus;
    assertModerationTransition(current, dto.status);
    const counts = await this.prisma.extensionReview.updateMany({
      where: { id: reviewId, moderationStatus: current },
      data: { moderationStatus: dto.status },
    });
    if (counts.count !== 1) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `评审状态已被并发修改（期望 ${current} → ${dto.status}）`);
    }
    await this.writeAudit(userId, pub.organizationId, 'marketplace.review.moderate', reviewId, {
      publicationId: review.publicationId, from: current, to: dto.status, ...(dto.reason ? { reason: dto.reason } : {}),
    });
    const updated = await this.prisma.extensionReview.findUniqueOrThrow({ where: { id: reviewId } });
    return updated as ReviewRow;
  }

  /** 调用者本人评审（含 pending——让用户看到"待审核"状态） */
  async findMine(userId: string, publicationId: string): Promise<ReviewRow | null> {
    const row = await this.prisma.extensionReview.findUnique({
      where: { publicationId_userId: { publicationId, userId } },
    });
    return (row as ReviewRow | null) ?? null;
  }

  /** 已通过评审的行（详情页回显；对外公开面只此一种） */
  async listApproved(publicationId: string, limit = REVIEW_PREVIEW_LIMIT): Promise<ReviewView[]> {
    const rows = await this.prisma.extensionReview.findMany({
      where: { publicationId, moderationStatus: 'approved' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return this.attachReviewers(rows as ReviewRow[]);
  }

  /** 批量补齐评论者展示名（只回显 displayName——**绝不**回显邮箱等联系方式） */
  private async attachReviewers(rows: ReviewRow[]): Promise<ReviewView[]> {
    if (!rows.length) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
      select: { id: true, displayName: true },
    });
    const byId = new Map(users.map((u) => [u.id, u.displayName]));
    return rows.map((r) => ({ ...r, reviewer: { userId: r.userId, displayName: byId.get(r.userId) ?? null } }));
  }

  private async requirePublication(id: string): Promise<PublicationScopeRow & { id: string; status: string }> {
    const pub = await this.prisma.extensionPublication.findUnique({ where: { id } });
    if (!pub) throw new AppError(ErrorCode.NOT_FOUND, '发布条目不存在');
    return pub;
  }

  private async writeAudit(
    userId: string, organizationId: string, action: string, targetId: string, metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.write({
      userId, organizationId, action, targetType: 'extension_review', targetId, metadata,
    }).catch(() => undefined); // best-effort
  }
}
