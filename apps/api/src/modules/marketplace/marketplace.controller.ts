import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { PublicationsService } from './publications.service';
import { ReviewsService } from './reviews.service';
import { MarketplaceCatalogService } from './marketplace-catalog.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../../core/rate-limit/rate-limit.guard';
import {
  CreatePublicationDto, CreatePublicationSchema, ListPublicationsDto, ListPublicationsSchema,
  ListReviewsDto, ListReviewsSchema, ModerateReviewDto, ModerateReviewSchema, RejectPublicationDto,
  RejectPublicationSchema, UpdatePublicationDto, UpdatePublicationSchema, UpsertReviewDto, UpsertReviewSchema,
} from './marketplace.dto';

/**
 * M9-P6 Marketplace API（JWT + 组织 RBAC；**复用既有权限位，不新增**）。
 *
 * - 目录/详情/评审读：任何已登录用户可读 public 面（published）；未上架条目仅发布者组织成员
 *   （非成员 404 防枚举——由服务层裁决，控制器不做可见性判断）；
 * - 发布者写（建条目/编辑/发布/撤回/修订）：发布者组织 `agent.write`（与 extensions 同口径）；
 * - 评审审核（moderation）：发布者组织 **owner/admin**（`member.write` 位恰为这两者）或平台管理员；
 * - 控制器**绝不直接写库**：全部经服务层（状态机 + CAS + 审计）；
 * - **绝不执行扩展内容**：本模块只读写声明式元数据与评审，权限始终由 M8-P6 物化路径决定。
 */
@Controller('marketplace')
@UseGuards(JwtAuthGuard)
export class MarketplaceController {
  constructor(
    @Inject(PublicationsService) private readonly publications: PublicationsService,
    @Inject(ReviewsService) private readonly reviews: ReviewsService,
    @Inject(MarketplaceCatalogService) private readonly catalog: MarketplaceCatalogService,
  ) {}

  // ===== 读（已登录即可）=====

  /** 目录检索：默认仅 published（公开面）；draft/rejected/all 需 organizationId + 成员身份 */
  @Get('publications')
  list(
    @Req() req: Request & { user: AuthedUser },
    @Query(new ZodValidationPipe(ListPublicationsSchema)) query: ListPublicationsDto,
  ) {
    return this.catalog.search(req.user.userId, query);
  }

  /** 分类白名单 + 已上架数量（过滤器数据源） */
  @Get('categories')
  categories() {
    return this.catalog.categories();
  }

  /** 详情：published 公开；未发布跨组织 404（防枚举） */
  @Get('publications/:id')
  detail(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.catalog.detail(req.user.userId, id);
  }

  /** 评审列表：默认仅 approved；pending/rejected 需审核权 */
  @Get('publications/:id/reviews')
  listReviews(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Query(new ZodValidationPipe(ListReviewsSchema)) query: ListReviewsDto,
  ) {
    return this.reviews.list(req.user.userId, id, query);
  }

  // ===== 发布者写（agent.write）=====

  /** 建草稿条目（一扩展一条目）；上架须再调 publish（门禁在服务层） */
  @Post('publications')
  create(@Req() req: Request & { user: AuthedUser }, @Body(new ZodValidationPipe(CreatePublicationSchema)) dto: CreatePublicationDto) {
    return this.publications.create(req.user.userId, dto);
  }

  /** 编辑（仅 draft/rejected；已上架须先撤回） */
  @Patch('publications/:id')
  update(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePublicationSchema)) dto: UpdatePublicationDto,
  ) {
    return this.publications.update(req.user.userId, id, dto);
  }

  /** 上架：draft → published（重跑平台校验门禁） */
  @Post('publications/:id/publish')
  publish(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.publications.publish(req.user.userId, id);
  }

  /** 撤回：published → draft（作者侧下架） */
  @Post('publications/:id/withdraw')
  withdraw(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.publications.withdraw(req.user.userId, id);
  }

  /** 修订：rejected → draft（驳回后回草稿，再上架重走门禁） */
  @Post('publications/:id/revise')
  revise(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.publications.revise(req.user.userId, id);
  }

  /** 驳回/下架（治理侧）：published → rejected；仅 owner/admin 或平台管理员 */
  @Post('publications/:id/reject')
  reject(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RejectPublicationSchema)) dto: RejectPublicationDto,
  ) {
    return this.publications.reject(req.user.userId, id, dto);
  }

  // ===== 评审 =====

  /** 打分/改分（upsert：一用户一条目一条评审；写入即回到 pending 待审） */
  @Post('publications/:id/reviews')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'marketplace-review', limit: 30, windowMs: 60_000 })
  upsertReview(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpsertReviewSchema)) dto: UpsertReviewDto,
  ) {
    return this.reviews.upsert(req.user.userId, id, dto);
  }

  /** 审核评审（pending→approved/rejected；approved↔rejected 复核） */
  @Post('reviews/:reviewId/moderation')
  moderateReview(
    @Req() req: Request & { user: AuthedUser },
    @Param('reviewId') reviewId: string,
    @Body(new ZodValidationPipe(ModerateReviewSchema)) dto: ModerateReviewDto,
  ) {
    return this.reviews.moderate(req.user.userId, reviewId, dto);
  }
}
