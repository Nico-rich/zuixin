import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards, UsePipes } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { BillingService } from './billing.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

const SubscribeSchema = z.strictObject({
  organizationId: z.string().min(8).max(100), // 组织 id 含 personal-{uuid} 前缀，非纯 UUID
  planId: z.string().uuid(),
});

/** M8-P2 Billing API（JWT + 组织 RBAC：billing.read/write；organizationId 经服务端 membership 校验） */
@Controller('billing')
@UseGuards(JwtAuthGuard)
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  @Get('plans')
  plans() {
    return this.billing.plans();
  }

  @Get('subscription')
  async subscription(@Req() req: Request & { user: AuthedUser }, @Query('organizationId') organizationId?: string) {
    const orgId = organizationId ?? (await this.orgs.ensurePersonalOrganization(req.user.userId)).id;
    await this.orgs.requirePermission(req.user.userId, orgId, 'billing.read');
    return this.billing.subscription(req.user.userId, orgId);
  }

  @Get('usage')
  async usage(@Req() req: Request & { user: AuthedUser }, @Query('organizationId') organizationId?: string, @Query('period') period?: string) {
    const orgId = organizationId ?? (await this.orgs.ensurePersonalOrganization(req.user.userId)).id;
    await this.orgs.requirePermission(req.user.userId, orgId, 'billing.read');
    return this.billing.usage(orgId, period);
  }

  @Get('invoices')
  async invoices(@Req() req: Request & { user: AuthedUser }, @Query('organizationId') organizationId?: string) {
    const orgId = organizationId ?? (await this.orgs.ensurePersonalOrganization(req.user.userId)).id;
    await this.orgs.requirePermission(req.user.userId, orgId, 'billing.read');
    return this.billing.invoices(orgId);
  }

  @Post('subscribe')
  @UsePipes(new ZodValidationPipe(SubscribeSchema))
  async subscribe(@Req() req: Request & { user: AuthedUser }, @Body() dto: { organizationId: string; planId: string }) {
    await this.orgs.requirePermission(req.user.userId, dto.organizationId, 'billing.write'); // owner 专属
    return this.billing.subscribe(req.user.userId, dto.organizationId, dto.planId);
  }
}
