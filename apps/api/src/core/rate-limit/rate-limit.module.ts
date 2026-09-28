import { Global, Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';
import { RateLimitGuard } from './rate-limit.guard';
import { GlobalRateLimitGuard } from './global-rate-limit.guard';

/** M7-P9 限流（全局提供 service + guard；守卫按装饰器配置启用）+ M10-P8 全局 per-IP 守卫（APP_GUARD 挂载于 app.module） */
@Global()
@Module({
  providers: [RateLimitService, RateLimitGuard, GlobalRateLimitGuard],
  exports: [RateLimitService, RateLimitGuard, GlobalRateLimitGuard],
})
export class RateLimitModule {}
