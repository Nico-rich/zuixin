import { Body, Controller, Delete, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ConnectionsService } from './connections.service';
import { CallbackQuerySchema, StartConnectionSchema } from './connections.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../../core/rate-limit/rate-limit.guard';

/**
 * M7-P2 Connection API（JWT + ownership + 404 防枚举；响应永不包含凭证）。
 * 真实平台接入前只有 mock provider；callback 为 JSON 完成态（mock 流程），真实平台可演进为 302 重定向。
 */
@Controller('connections')
@UseGuards(JwtAuthGuard)
export class ConnectionsController {
  constructor(@Inject(ConnectionsService) private readonly connections: ConnectionsService) {}

  @Get()
  list(@Req() req: Request & { user: AuthedUser }, @Query('provider') provider?: string) {
    return this.connections.list(req.user.userId, provider);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.connections.get(req.user.userId, id);
  }

  /** 发起 OAuth（建 single-use state）→ authorizeUrl */
  @Post(':provider/start')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'oauth-start', limit: 30, windowMs: 60_000 })
  start(
    @Req() req: Request & { user: AuthedUser },
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(StartConnectionSchema)) dto: { projectId?: string | null },
  ) {
    return this.connections.start(req.user.userId, provider, dto);
  }

  /** OAuth 回调（state 单次消费 + 交换 token + 加密入库） */
  @Get(':provider/callback')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'oauth-callback', limit: 60, windowMs: 60_000 })
  callback(
    @Req() req: Request & { user: AuthedUser },
    @Param('provider') provider: string,
    @Query(new ZodValidationPipe(CallbackQuerySchema)) q: { state: string; code: string },
  ) {
    return this.connections.callback(req.user.userId, provider, q);
  }

  @Post(':id/refresh')
  refresh(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.connections.refresh(req.user.userId, id);
  }

  @Post(':id/revoke')
  revoke(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.connections.revoke(req.user.userId, id);
  }

  @Delete(':id')
  remove(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.connections.remove(req.user.userId, id);
  }
}
