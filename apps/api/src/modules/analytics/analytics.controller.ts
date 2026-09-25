import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { AnalyticsService, AnalyticsRange } from './analytics.service';
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

/**
 * M8-P4 Analytics API（JWT + 组织成员校验）：
 * - organizationId 缺省 = 请求者个人组织（服务端解析，绝不信客户端归属）；
 * - RBAC：requireMembership（组织成员可读——分析读面与 billing.read 同属只读；
 *   非成员/组织不存在 → 403，绝不泄露统计）。deny-by-default：未认证 → 401。
 * - 响应只含确定性事实 + 服务端 derived（绝无 LLM 解读）。
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
