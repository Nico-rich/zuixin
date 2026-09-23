import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AgentRunsService } from './agent-runs.service';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppError, ErrorCode } from '../../common/errors/app-error';

@Controller('agent-runs')
@UseGuards(JwtAuthGuard)
export class AgentRunsController {
  constructor(@Inject(AgentRunsService) private readonly runs: AgentRunsService) {}

  @Get()
  list(@Req() req: Request & { user: AuthedUser }, @Query('conversationId') conversationId?: string) {
    if (!conversationId) throw new AppError(ErrorCode.VALIDATION_ERROR, '缺少 conversationId');
    return this.runs.listByConversation(req.user.userId, conversationId);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.runs.get(req.user.userId, id);
  }
}
