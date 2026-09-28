import { Body, Controller, Delete, Inject, Param, Patch, Post, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import { Request, Response } from 'express';
import { ChatService } from './chat.service';
import { ChatDtoSchema, EditMessageDto, EditMessageDtoSchema } from './chat.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SSEWriter, SSESink } from './sse-writer';
import { SseRegistryService } from '../../core/sse/sse-registry.service';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  // 注：构造参数属性不能与路由方法同名（实例字段会遮蔽原型方法）；这里用 chatService 命名
  constructor(
    @Inject(ChatService) private readonly chatService: ChatService,
    // Pre-M9 G3：SSE 连接纳管（停机时拒绝新订阅 + 主动关闭已建立连接）
    @Inject(SseRegistryService) private readonly sse: SseRegistryService,
  ) {}

  @Post()
  @UsePipes(new ZodValidationPipe(ChatDtoSchema))
  async chat(
    @Req() req: Request & { user: AuthedUser; id?: string },
    @Res() res: Response,
    @Body() dto: { conversationId?: string | null; message: string },
  ) {
    const requestId = req.id ?? 'req';
    // Pre-M9 G3：停机排空期拒绝新订阅（503：服务端状态裁决）
    if (this.sse.isDraining()) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: '服务正在优雅停机，暂不接受新的 SSE 订阅' } }));
      return;
    }
    // 锁/会话/消息在 SSE 开始前完成——此阶段错误走统一 JSON envelope
    const ctx = await this.chatService.prepareChat(req.user.userId, dto, requestId);

    const writer = new SSEWriter(res as unknown as SSESink);
    writer.init();
    const unregister = this.sse.add('chat', res as unknown as { end(): void; writableEnded?: boolean });
    const abort = new AbortController();
    const heartbeat = setInterval(() => writer.ping(), 15000);
    // M6-P2 修复（M1 潜伏 bug）：req 'close' 在 POST 请求体消费完即触发（Node 语义 = 请求完成，非连接断开），
    // 注册时机晚于其触发 → 客户端断连从未真正取消。连接级事件是 res 'close'：
    // 正常 end() 后也会触发（writableEnded=true，abort 为无害 no-op）；中途断开时 writableEnded=false → 真正取消。
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', onClose);
    try {
      await this.chatService.streamChat(ctx, writer, abort.signal, requestId);
    } finally {
      clearInterval(heartbeat);
      res.off('close', onClose);
      unregister(); // 连接结束 → 移出纳管集合
      writer.end();
    }
  }

  /**
   * M10-P3 编辑消息（PATCH /chat/messages/:id）——仅本人 + role=user 的消息可改 content。
   * 越权（跨租户/非本人/不存在）→ 404 反枚举；本人的非 user 消息 → 403 MESSAGE_EDIT_FORBIDDEN；
   * 非法请求体（空/超长）→ 400 VALIDATION_ERROR（zod，上限与发消息同源 20000）。
   */
  @Patch('messages/:id')
  editMessage(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(EditMessageDtoSchema)) dto: EditMessageDto,
  ) {
    return this.chatService.editMessage(req.user.userId, id, dto);
  }

  /**
   * M10-P3 删除消息（DELETE /chat/messages/:id）——仅本人 + role=user 的消息（硬删除，schema 无 deletedAt）。
   * 授权判定与编辑完全同源（同一私有方法），错误码为 MESSAGE_DELETE_FORBIDDEN。
   * 删除前先触发摘要陈旧标记，删除后自愈重算（见 ChatService.deleteMessage 的顺序说明）。
   */
  @Delete('messages/:id')
  deleteMessage(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.chatService.deleteMessage(req.user.userId, id);
  }
}
