import { Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { WorkflowRunsService } from './workflow-runs.service';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

/** M7-P6 WorkflowRun 读/生命周期面（JWT + ownership + 404 防枚举） */
@Controller('workflows/runs')
@UseGuards(JwtAuthGuard)
export class WorkflowRunsController {
  constructor(@Inject(WorkflowRunsService) private readonly runs: WorkflowRunsService) {}

  @Get(':runId')
  get(@Req() req: Request & { user: AuthedUser }, @Param('runId') runId: string) {
    return this.runs.get(req.user.userId, runId);
  }

  @Get(':runId/timeline')
  timeline(@Req() req: Request & { user: AuthedUser }, @Param('runId') runId: string) {
    return this.runs.timeline(req.user.userId, runId);
  }

  @Post(':runId/cancel')
  cancel(@Req() req: Request & { user: AuthedUser }, @Param('runId') runId: string) {
    return this.runs.cancel(req.user.userId, runId);
  }

  @Post(':runId/retry')
  retry(@Req() req: Request & { user: AuthedUser }, @Param('runId') runId: string) {
    return this.runs.retry(req.user.userId, runId);
  }
}
