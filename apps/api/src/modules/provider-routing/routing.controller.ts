import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards, UsePipes } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { RoutingService } from './routing.service';
import { ProviderPoliciesService } from './policies.service';
import { ProviderCapabilitiesService } from './capabilities.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

const UpsertPolicySchema = z.strictObject({
  // 缺省 = 请求者的个人组织；显式 null = 平台级策略（仅管理员）
  organizationId: z.string().min(1).max(100).nullish(),
  providerId: z.string().min(1).max(100),
  allow: z.boolean().optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  costCeilingPerRequest: z.number().nonnegative().nullish(),
  costCeilingMonthly: z.number().nonnegative().nullish(),
  dataPolicy: z.record(z.unknown()).nullish(),
  enabled: z.boolean().optional(),
});

const ListCapabilitiesSchema = z.object({
  capability: z.string().min(1).max(64).optional(),
  providerId: z.string().min(1).max(100).optional(),
});

/**
 * M8-P7 路由管理/审计 API（JWT + 组织 RBAC）：
 * - 决策审计：org 成员可读（org 校验服务端做，绝不信客户端 organizationId）；
 * - 组织策略：member.write（owner/admin）可写、成员可读；平台级策略（organizationId=null）仅 admin；
 * - 能力目录：平台级派生数据，维护（sync）仅 admin、读取登录即可。
 * 注意：路由决策本身**不暴露为 HTTP 端点**——选谁由服务端在被调用方（chat/media/agent 路径）内决定，
 * 外部只能事后审计，避免客户端指定 provider。
 */
@Controller('routing')
@UseGuards(JwtAuthGuard)
export class RoutingController {
  constructor(
    @Inject(RoutingService) private readonly routing: RoutingService,
    @Inject(ProviderPoliciesService) private readonly policies: ProviderPoliciesService,
    @Inject(ProviderCapabilitiesService) private readonly capabilities: ProviderCapabilitiesService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  /** runId / organizationId 二选一；只给 runId 时仅返回请求者所属组织的决策 */
  @Get('decisions')
  async decisions(
    @Req() req: Request & { user: AuthedUser },
    @Query('runId') runId?: string,
    @Query('organizationId') organizationId?: string,
    @Query('limit') limit?: string,
  ) {
    const take = limit ? Number(limit) : undefined;
    if (organizationId) {
      await this.orgs.requirePermission(req.user.userId, organizationId, 'organization.read');
      return this.routing.listDecisions({ organizationId, runId, limit: take });
    }
    if (runId) {
      const orgIds = (await this.orgs.list(req.user.userId)).map((o) => o.id);
      if (orgIds.length === 0) return [];
      return this.routing.listDecisions({ organizationIds: orgIds, runId, limit: take });
    }
    const orgId = (await this.orgs.ensurePersonalOrganization(req.user.userId)).id;
    await this.orgs.requirePermission(req.user.userId, orgId, 'organization.read');
    return this.routing.listDecisions({ organizationId: orgId, limit: take });
  }

  @Post('policies')
  @UsePipes(new ZodValidationPipe(UpsertPolicySchema))
  async upsertPolicy(
    @Req() req: Request & { user: AuthedUser },
    @Body() dto: z.infer<typeof UpsertPolicySchema>,
  ) {
    const organizationId = dto.organizationId === undefined
      ? (await this.orgs.ensurePersonalOrganization(req.user.userId)).id
      : dto.organizationId;
    return this.policies.upsert({ userId: req.user.userId, role: req.user.role }, { ...dto, organizationId });
  }

  @Get('policies')
  async listPolicies(
    @Req() req: Request & { user: AuthedUser },
    @Query('organizationId') organizationId?: string,
    @Query('platform') platform?: string,
  ) {
    if (platform === 'true') return this.policies.listPlatform({ userId: req.user.userId, role: req.user.role });
    const orgId = organizationId ?? (await this.orgs.ensurePersonalOrganization(req.user.userId)).id;
    return this.policies.list({ userId: req.user.userId, role: req.user.role }, orgId);
  }

  @Post('capabilities/sync')
  async syncCapabilities(@Req() req: Request & { user: AuthedUser }) {
    if (req.user.role !== 'admin') throw new AppError(ErrorCode.FORBIDDEN, '能力目录维护仅平台管理员');
    return this.capabilities.syncFromProviders();
  }

  @Get('capabilities')
  @UsePipes(new ZodValidationPipe(ListCapabilitiesSchema))
  async listCapabilities(@Query() query: z.infer<typeof ListCapabilitiesSchema>) {
    return this.capabilities.list(query);
  }
}
