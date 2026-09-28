import { Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { EventPlatformService } from './event-platform.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * M8-P5 事件平台 API（JWT + 组织 RBAC；P5 不新增权限位 → 复用 workflow.read/write 语义）。
 * 只暴露"读 + 死信重投"：事件由领域代码经 EventPlatformService.publish 产生（HTTP 不发事件，
 * 避免把事件总线变成任意外部写入面）。
 *
 * Pre-M9 G10：**FROZEN（冻结，方案 B）**。本控制器**只读 + 死信重投**，不新增任何写入/订阅/relay 端点；
 * 冻结期无消费者的事件会长期停留在 published（预期现象），dead 仅由显式消费失败产生。
 */
@Controller('events')
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(
    @Inject(EventPlatformService) private readonly platform: EventPlatformService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  @Get()
  async list(
    @Req() req: Request & { user: AuthedUser },
    @Query('organizationId') organizationId?: string,
    @Query('eventType') eventType?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const orgId = organizationId ?? (await this.orgs.ensurePersonalOrganization(req.user.userId)).id;
    await this.orgs.requirePermission(req.user.userId, orgId, 'workflow.read');
    const events = await this.platform.list(req.user.userId, {
      organizationId: orgId, eventType, status, limit: limit ? Number(limit) : undefined,
    });
    return { events };
  }

  @Get('dead-letter')
  async deadLetters(
    @Req() req: Request & { user: AuthedUser },
    @Query('organizationId') organizationId?: string,
    @Query('limit') limit?: string,
  ) {
    const orgId = organizationId ?? (await this.orgs.ensurePersonalOrganization(req.user.userId)).id;
    await this.orgs.requirePermission(req.user.userId, orgId, 'workflow.read');
    const events = await this.platform.deadLetterList(req.user.userId, { organizationId: orgId, limit: limit ? Number(limit) : undefined });
    return { events };
  }

  @Post(':eventId/redeliver')
  async redeliver(@Req() req: Request & { user: AuthedUser }, @Param('eventId') eventId: string) {
    // M10-P15（BUG-11）：平台级（无组织）事件仅平台管理员可重投（与 /routing/capabilities/sync 同一口径）
    return this.platform.redeliver(req.user.userId, eventId, { platformAdmin: req.user.role === 'admin' });
  }
}
