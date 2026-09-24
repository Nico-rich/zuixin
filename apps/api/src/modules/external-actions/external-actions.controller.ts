import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ExternalActionsService } from './external-actions.service';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * M7-P3 ExternalAction 审计读取面（JWT + ownership + 404 防枚举）：
 * 动作由 Tool/Workflow 执行产生（无客户端直建端点）；响应不含任何凭证字段。
 */
@Controller('external-actions')
@UseGuards(JwtAuthGuard)
export class ExternalActionsController {
  constructor(@Inject(ExternalActionsService) private readonly actions: ExternalActionsService) {}

  @Get()
  list(@Req() req: Request & { user: AuthedUser }, @Query('agentRunId') agentRunId?: string) {
    return this.actions.list(req.user.userId, agentRunId);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.actions.get(req.user.userId, id);
  }
}
