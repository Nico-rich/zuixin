import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ObservabilityService } from '../../core/tracing/observability.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * M8-P3 指标读取面（userId 首条件——绝不返回他人样本）：
 * - 不带 organizationId：仅本人产生的样本（HTTP/Worker 上下文按 labels.userId 归属）；
 * - 带 organizationId：先过 membership（非成员 403，绝不泄露组织存在性以外的信息），再返回组织样本 ∪ 本人样本。
 */
@Controller('metrics')
@UseGuards(JwtAuthGuard)
export class ObservabilityController {
  constructor(
    @Inject(ObservabilityService) private readonly metrics: ObservabilityService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  @Get()
  async list(
    @Req() req: Request & { user: AuthedUser },
    @Query('name') name?: string,
    @Query('organizationId') organizationId?: string,
    @Query('limit') limit?: string,
  ) {
    if (organizationId) await this.orgs.requireMembership(req.user.userId, organizationId); // 非成员 → 403
    return this.metrics.list(req.user.userId, {
      name: name || undefined,
      organizationId: organizationId || undefined,
      limit: Number(limit) || 100,
    });
  }
}
