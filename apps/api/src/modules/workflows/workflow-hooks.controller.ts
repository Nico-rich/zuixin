import { Controller, Headers, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { WorkflowTriggersService } from './workflow-triggers.service';
import { RateLimit, RateLimitGuard } from '../../core/rate-limit/rate-limit.guard';
import { WebhookGlobalThrottleGuard } from './webhook-global-throttle.guard';

/**
 * M7-P6 公开 Webhook 端点（无 JWT/无 CSRF——鉴权 = HMAC-SHA256 签名 + timestamp ±5min + eventId 防重放）：
 * POST /api/v1/hooks/workflows/:token
 * 头：X-Hook-Signature（hex hmac-sha256 of raw body）/ X-Hook-Timestamp（ms）/ X-Hook-Event-Id
 * 注册于 main.ts 的 raw-body 中间件（校验需要原始字节）；响应绝不泄露工作流内部信息。
 *
 * M10-P5 SA-16/SA-17：速率**两道闸** —— per-token（本装饰器，120/min）先行，
 * 再叠加与 token 无关的**全局总闸**（WebhookGlobalThrottleGuard），后者的键不可被换 token 绕过。
 */
@Controller('hooks')
export class WorkflowHooksController {
  constructor(@Inject(WorkflowTriggersService) private readonly triggers: WorkflowTriggersService) {}

  @Post('workflows/:token')
  @UseGuards(RateLimitGuard, WebhookGlobalThrottleGuard)
  @RateLimit({ name: 'webhook', limit: 120, windowMs: 60_000, keyFn: (req) => `webhook:${((req as unknown as { params: { token?: string } }).params?.token) ?? 'anon'}` })
  async receive(
    @Req() req: Request,
    @Param('token') token: string,
    @Headers('x-hook-signature') signature?: string,
    @Headers('x-hook-timestamp') timestamp?: string,
    @Headers('x-hook-event-id') eventId?: string,
  ) {
    const raw = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}), 'utf8');
    return this.triggers.handleWebhook(token, raw, { signature, timestamp, eventId });
  }
}
