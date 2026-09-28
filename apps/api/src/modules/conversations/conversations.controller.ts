import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { ConversationsService, Paged } from './conversations.service';
import {
  CreateConversationDtoSchema, ListConversationsQuery, ListConversationsQuerySchema,
  ListMessagesQuery, ListMessagesQuerySchema, UpdateConversationDtoSchema,
} from './conversations.dto';
import { PageMeta } from './cursor';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * 分页元数据经**响应头**返回：响应体保持 `{ data: [...] }` 数组形状（M0~M9 既有调用方——
 * Web 历史消息、生成类 e2e——直接遍历 data，不因引入游标而破坏信封契约）。
 */
function writePageHeaders(res: Response, meta: PageMeta): void {
  res.setHeader('X-Page-Limit', String(meta.limit));
  res.setHeader('X-Page-Has-More', meta.hasMore ? 'true' : 'false');
  res.setHeader('X-Page-Order', meta.order);
  if (meta.nextCursor) res.setHeader('X-Page-Next-Cursor', meta.nextCursor);
  if (meta.prevCursor) res.setHeader('X-Page-Prev-Cursor', meta.prevCursor);
}

// 注：校验管道挂在 @Body 参数上而非方法级——方法级 @UsePipes 会作用于 @Param('id')，把路径参数当 DTO 校验
@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(@Inject(ConversationsService) private readonly conversations: ConversationsService) {}

  /** M10-P3：`limit` / `before` / `after` 游标分页（不传 = 旧行为：首页 50 条，updatedAt desc） */
  @Get()
  async list(
    @Req() req: Request & { user: AuthedUser },
    @Query(new ZodValidationPipe(ListConversationsQuerySchema)) query: ListConversationsQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const page: Paged<unknown> = await this.conversations.list(req.user.userId, query);
    writePageHeaders(res, page.meta);
    return page.items;
  }

  @Post()
  create(@Req() req: Request & { user: AuthedUser }, @Body(new ZodValidationPipe(CreateConversationDtoSchema)) dto: { title?: string; projectId?: string | null }) {
    return this.conversations.create(req.user.userId, dto);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.conversations.get(req.user.userId, id);
  }

  @Patch(':id')
  update(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(UpdateConversationDtoSchema)) dto: { title?: string; projectId?: string | null }) {
    return this.conversations.update(req.user.userId, id, dto);
  }

  @Delete(':id')
  remove(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.conversations.softDelete(req.user.userId, id);
  }

  /**
   * M10-P3（ARCH-11）：消息列表游标分页——`(createdAt, id)` 复合游标，参数 `limit` / `before` / `after`。
   * 不传分页参数 = 旧行为（首页 200 条、时间正序）；响应头回传 next/prev 游标。
   */
  @Get(':id/messages')
  async messages(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Query(new ZodValidationPipe(ListMessagesQuerySchema)) query: ListMessagesQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const page: Paged<unknown> = await this.conversations.getMessages(req.user.userId, id, query);
    writePageHeaders(res, page.meta);
    return page.items;
  }
}
