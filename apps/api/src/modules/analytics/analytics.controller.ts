import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { AnalyticsService, AnalyticsRange, periodOf } from './analytics.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OrgId = z.string().min(8).max(100); // 组织 id 含 personal-{uuid} 前缀，非纯 UUID

const OverviewQuerySchema = z.strictObject({
  organizationId: OrgId.optional(),
  range: z.enum(['day', 'week', 'month']).optional(),
});

const BreakdownQuerySchema = z.strictObject({
  organizationId: OrgId.optional(),
  kind: z.enum(['usage', 'agent', 'generation', 'provider', 'workflow']).optional(),
  days: z.coerce.number().int().min(1).max(366).optional(),
});

const SourcesQuerySchema = z.strictObject({
  organizationId: OrgId.optional(),
  period: z.string().regex(DAY, '期望 YYYY-MM-DD').optional(),
});

const RefreshBodySchema = z.strictObject({
  organizationId: OrgId.optional(),
  from: z.string().regex(DAY, '期望 YYYY-MM-DD').optional(),
  to: z.string().regex(DAY, '期望 YYYY-MM-DD').optional(),
});

/**
 * M8-P4 Analytics API（JWT + 组织成员校验）：
 * - organizationId 缺省 = 请求者个人组织（服务端解析，绝不信客户端归属）；
 * - RBAC：requireMembership（组织成员可读——分析读面与 billing.read 同属只读；
 *   非成员/组织不存在 → 403，绝不泄露统计）。deny-by-default：未认证 → 401。
 * - 响应只含确定性事实 + 服务端 derived（绝无 LLM 解读）。
 * - P2：读端点（overview/breakdown）只补刷**当日**（单日幂等），历史聚合由
 *   POST /analytics/refresh 显式维护（该写端点要求 billing.write = 组织 owner）。
 */
@Controller('analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  /** 组织归属解析：显式 organizationId 或请求者个人组织 */
  private async resolveOrg(userId: string, organizationId?: string): Promise<string> {
    return organizationId ?? (await this.orgs.ensurePersonalOrganization(userId)).id;
  }

  @Get('overview')
  async overview(
    @Req() req: Request & { user: AuthedUser },
    @Query(new ZodValidationPipe(OverviewQuerySchema)) query: { organizationId?: string; range?: AnalyticsRange },
  ) {
    const orgId = await this.resolveOrg(req.user.userId, query.organizationId);
    await this.orgs.requireMembership(req.user.userId, orgId);
    return this.analytics.overview(orgId, query.range ?? 'day');
  }

  @Get('breakdown')
  async breakdown(
    @Req() req: Request & { user: AuthedUser },
    @Query(new ZodValidationPipe(BreakdownQuerySchema)) query: { organizationId?: string; kind?: 'usage' | 'agent' | 'generation' | 'provider' | 'workflow'; days?: number },
  ) {
    const orgId = await this.resolveOrg(req.user.userId, query.organizationId);
    await this.orgs.requireMembership(req.user.userId, orgId);
    return this.analytics.breakdown(orgId, { kind: query.kind, days: query.days ?? 30 });
  }

  /**
   * P2 显式刷新（刷新移出读请求路径后的唯一写入口；历史区间聚合由此维护）：
   * 缺省刷当日；from/to ≤366 天（服务端校验）；幂等（同 (org,user,kind,period,source) 只更新不新增）。
   */
  @Post('refresh')
  async refresh(
    @Req() req: Request & { user: AuthedUser },
    @Body(new ZodValidationPipe(RefreshBodySchema)) body: { organizationId?: string; from?: string; to?: string },
  ) {
    const orgId = await this.resolveOrg(req.user.userId, body.organizationId);
    // 组织级写操作（写聚合行）→ billing.write（仅 owner）——只读成员绝不触发组织级重算
    await this.orgs.requirePermission(req.user.userId, orgId, 'billing.write');
    const to = body.to ?? periodOf(new Date());
    return this.analytics.refreshAll(orgId, body.from ?? to, to);
  }

  @Get('sources')
  async sources(
    @Req() req: Request & { user: AuthedUser },
    @Query(new ZodValidationPipe(SourcesQuerySchema)) query: { organizationId?: string; period?: string },
  ) {
    const orgId = await this.resolveOrg(req.user.userId, query.organizationId);
    await this.orgs.requireMembership(req.user.userId, orgId);
    return this.analytics.sources(orgId, query.period);
  }
}
