import { Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { TasksService } from './tasks.service';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppError, ErrorCode } from '../../common/errors/app-error';

@Controller('tasks')
@UseGuards(JwtAuthGuard)
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.tasks.get(req.user.userId, id);
  }

  @Get()
  list(@Req() req: Request & { user: AuthedUser }, @Query('conversationId') conversationId?: string) {
    if (!conversationId) throw new AppError(ErrorCode.VALIDATION_ERROR, '缺少 conversationId');
    return this.tasks.listByConversation(req.user.userId, conversationId);
  }

  @Post(':id/cancel')
  cancel(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.tasks.cancelPending(req.user.userId, id);
  }
}
