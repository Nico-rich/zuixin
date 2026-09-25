import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { WorkflowsService } from './workflows.service';
import { WorkflowRunsService } from './workflow-runs.service';
import { CreateWorkflowSchema, UpdateWorkflowSchema, CreateWorkflowRunSchema } from './workflows.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorkflowDefinition } from './workflow-types';

/**
 * M7-P6 Workflow API（JWT + ownership + 404 防枚举）：
 * 版本不可变（编辑=新版本）；Run 锁定 published 版本；幂等键去重（部分唯一索引 attempt=1）。
 */
@Controller('workflows')
@UseGuards(JwtAuthGuard)
export class WorkflowsController {
  constructor(
    @Inject(WorkflowsService) private readonly workflows: WorkflowsService,
    @Inject(WorkflowRunsService) private readonly runs: WorkflowRunsService,
  ) {}

  @Get()
  list(@Req() req: Request & { user: AuthedUser }) {
    return this.workflows.list(req.user.userId);
  }

  @Post()
  create(
    @Req() req: Request & { user: AuthedUser },
    @Body(new ZodValidationPipe(CreateWorkflowSchema)) dto: { name: string; description?: string; projectId?: string | null; definition: WorkflowDefinition },
  ) {
    return this.workflows.create(req.user.userId, dto);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.workflows.get(req.user.userId, id);
  }

  @Patch(':id')
  update(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateWorkflowSchema)) dto: { name?: string; description?: string | null; definition?: WorkflowDefinition },
  ) {
    return this.workflows.update(req.user.userId, id, {
      name: dto.name,
      description: dto.description ?? undefined,
      definition: dto.definition,
    });
  }

  @Post(':id/publish')
  publish(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.workflows.publish(req.user.userId, id);
  }

  @Post(':id/archive')
  archive(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.workflows.archive(req.user.userId, id);
  }

  @Delete(':id')
  remove(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.workflows.remove(req.user.userId, id);
  }

  /** Run 创建（manual 触发；幂等键去重） */
  @Post(':id/runs')
  createRun(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateWorkflowRunSchema)) dto: { payload?: Record<string, unknown>; idempotencyKey?: string },
  ) {
    return this.runs.createRun(req.user.userId, {
      workflowId: id, triggerType: 'manual', triggerId: undefined,
      idempotencyKey: dto.idempotencyKey, payload: dto.payload,
    });
  }

  @Get(':id/runs')
  listRuns(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Query('take') take?: string) {
    return this.runs.list(req.user.userId, id, Number(take) || 20);
  }
}
