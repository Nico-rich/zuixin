import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards, UsePipes } from '@nestjs/common';
import { Request } from 'express';
import { AgentRunsService } from './agent-runs.service';
import { AgentRunTimelineService } from './agent-run-timeline.service';
import { CreateAgentRunSchema } from './agent-runs.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppError, ErrorCode } from '../../common/errors/app-error';

@Controller('agent-runs')
@UseGuards(JwtAuthGuard)
export class AgentRunsController {
  constructor(
    @Inject(AgentRunsService) private readonly runs: AgentRunsService,
    @Inject(AgentRunTimelineService) private readonly timeline: AgentRunTimelineService,
  ) {}

  @Get()
  list(@Req() req: Request & { user: AuthedUser }, @Query('conversationId') conversationId?: string) {
    if (!conversationId) throw new AppError(ErrorCode.VALIDATION_ERROR, '缺少 conversationId');
    return this.runs.listByConversation(req.user.userId, conversationId);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.runs.get(req.user.userId, id);
  }

  /** M6-P3 异步入口：创建即返回（201 {runId, status:'queued'}），执行在 Worker 进程 */
  @Post()
  @UsePipes(new ZodValidationPipe(CreateAgentRunSchema))
  create(@Req() req: Request & { user: AuthedUser }, @Body() dto: { agentId?: string; conversationId?: string | null; projectId?: string | null; message: string }) {
    return this.runs.createAsync(req.user.userId, dto);
  }

  /** Timeline 投影（持久化历史；浏览器刷新后可完整恢复，不依赖 SSE） */
  @Get(':id/timeline')
  timelineOf(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.timeline.build(req.user.userId, id);
  }
}
