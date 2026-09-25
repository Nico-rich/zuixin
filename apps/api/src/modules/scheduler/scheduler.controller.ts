import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { SchedulerService, ScheduledJobType } from './scheduler.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

const ScheduleJobSchema = z.strictObject({
  name: z.string().min(1).max(120),
  handler: z.string().min(1).max(64), // 服务端注册表标识（绝不执行任意代码）
  type: z.enum(['one-shot', 'delayed', 'recurring']).optional(),
  cron: z.string().min(5).max(120).optional(),
  runAt: z.union([z.string(), z.number()]).optional(),
  payload: z.record(z.unknown()).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  backoffMs: z.number().int().min(0).max(600_000).optional(),
  idempotencyKey: z.string().min(1).max(160).optional(), // 同键 → 返回已有作业（绝不重复调度）
  organizationId: z.string().min(8).max(100).optional(),
});

/**
 * M8-P5 Scheduler API（JWT + 组织 RBAC）。
 * P5 不新增 RBAC 权限位（M8-P1 矩阵已冻结）：调度作业按 workflow.read/write 语义裁决——
 * 读列表/详情 = workflow.read（viewer 可读），创建/取消/暂停/恢复 = workflow.write（member 起）。
 * organizationId 缺省 = 请求者个人组织；显式传入时经服务端 membership 裁决（防跨组织 IDOR）。
 */
@Controller('scheduler/jobs')
@UseGuards(JwtAuthGuard)
export class SchedulerController {
  constructor(
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  @Post()
  async schedule(
    @Req() req: Request & { user: AuthedUser },
    @Body(new ZodValidationPipe(ScheduleJobSchema)) dto: {
      name: string; handler: string; type?: ScheduledJobType; cron?: string; runAt?: string | number;
      payload?: Record<string, unknown>; priority?: number; timeoutMs?: number; maxAttempts?: number;
      backoffMs?: number; idempotencyKey?: string; organizationId?: string;
    },
  ) {
    const orgId = dto.organizationId ?? (await this.orgs.ensurePersonalOrganization(req.user.userId)).id;
    await this.orgs.requirePermission(req.user.userId, orgId, 'workflow.write');
    const { job, created } = await this.scheduler.schedule({ ...dto, ownerUserId: req.user.userId, organizationId: orgId });
    return { job, created };
  }

  @Get()
  async list(
    @Req() req: Request & { user: AuthedUser },
    @Query('organizationId') organizationId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const orgId = organizationId ?? (await this.orgs.ensurePersonalOrganization(req.user.userId)).id;
    await this.orgs.requirePermission(req.user.userId, orgId, 'workflow.read');
    const rows = await this.scheduler.list(req.user.userId, {
      organizationId: orgId, status, limit: limit ? Number(limit) : undefined,
    });
    return { jobs: rows, handlers: this.scheduler.listHandlers() };
  }

  @Post(':id/cancel')
  async cancel(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    const row = await this.scheduler.get(req.user.userId, id);
    if (row.organizationId) await this.orgs.requirePermission(req.user.userId, row.organizationId, 'workflow.write');
    return this.scheduler.cancel(req.user.userId, id);
  }

  @Post(':id/pause')
  async pause(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    const row = await this.scheduler.get(req.user.userId, id);
    if (row.organizationId) await this.orgs.requirePermission(req.user.userId, row.organizationId, 'workflow.write');
    return this.scheduler.pause(req.user.userId, id);
  }

  @Post(':id/resume')
  async resume(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    const row = await this.scheduler.get(req.user.userId, id);
    if (row.organizationId) await this.orgs.requirePermission(req.user.userId, row.organizationId, 'workflow.write');
    return this.scheduler.resume(req.user.userId, id);
  }
}
