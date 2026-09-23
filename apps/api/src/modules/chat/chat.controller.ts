import { Body, Controller, Inject, Post, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import { Request, Response } from 'express';
import { ChatService } from './chat.service';
import { ChatDtoSchema } from './chat.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SSEWriter, SSESink } from './sse-writer';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  // 注：构造参数属性不能与路由方法同名（实例字段会遮蔽原型方法）；这里用 chatService 命名
  constructor(@Inject(ChatService) private readonly chatService: ChatService) {}

  @Post()
  @UsePipes(new ZodValidationPipe(ChatDtoSchema))
  async chat(
    @Req() req: Request & { user: AuthedUser; id?: string },
    @Res() res: Response,
    @Body() dto: { conversationId?: string | null; message: string },
  ) {
    const requestId = req.id ?? 'req';
    // 锁/会话/消息在 SSE 开始前完成——此阶段错误走统一 JSON envelope
    const ctx = await this.chatService.prepareChat(req.user.userId, dto, requestId);

    const writer = new SSEWriter(res as unknown as SSESink);
    writer.init();
    const abort = new AbortController();
    const heartbeat = setInterval(() => writer.ping(), 15000);
    const onClose = () => abort.abort();
    req.on('close', onClose);
    try {
      await this.chatService.streamChat(ctx, writer, abort.signal, requestId);
    } finally {
      clearInterval(heartbeat);
      req.off('close', onClose);
      writer.end();
    }
  }
}
