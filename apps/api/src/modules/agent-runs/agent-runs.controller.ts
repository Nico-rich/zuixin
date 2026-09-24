import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AgentRunsService } from './agent-runs.service';
import { AgentRunTimelineService } from './agent-run-timeline.service';
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

  /** Timeline 投影（持久化历史；浏览器刷新后可完整恢复，不依赖 SSE） */
  @Get(':id/timeline')
  timelineOf(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.timeline.build(req.user.userId, id);
  }
}
