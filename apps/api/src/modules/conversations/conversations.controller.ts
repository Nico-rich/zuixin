import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ConversationsService } from './conversations.service';
import { CreateConversationDtoSchema, UpdateConversationDtoSchema } from './conversations.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

// 注：校验管道挂在 @Body 参数上而非方法级——方法级 @UsePipes 会作用于 @Param('id')，把路径参数当 DTO 校验
@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(@Inject(ConversationsService) private readonly conversations: ConversationsService) {}

  @Get()
  list(@Req() req: Request & { user: AuthedUser }) {
    return this.conversations.list(req.user.userId);
  }

  @Post()
  create(@Req() req: Request & { user: AuthedUser }, @Body(new ZodValidationPipe(CreateConversationDtoSchema)) dto: { title?: string }) {
    return this.conversations.create(req.user.userId, dto);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.conversations.get(req.user.userId, id);
  }

  @Patch(':id')
  rename(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(UpdateConversationDtoSchema)) dto: { title: string }) {
    return this.conversations.rename(req.user.userId, id, dto.title);
  }

  @Delete(':id')
  remove(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.conversations.softDelete(req.user.userId, id);
  }

  @Get(':id/messages')
  messages(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.conversations.getMessages(req.user.userId, id);
  }
}
