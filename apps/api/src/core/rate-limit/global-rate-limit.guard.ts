import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { RateLimitService } from './rate-limit.service';
import { evaluateGlobalRateLimit, globalRateLimitConfig, RateLimitRequestLike } from './global-rate-limit.policy';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/** 非生产环境放宽阈值的一次性告警（避免"为什么本地不限流"变成排查题） */
let relaxedWarned = false;

/** 单测复位一次性告警标志 */
export function resetRelaxedWarning(): void {
  relaxedWarned = false;
}

/**
 * M10-P8 全局 per-IP 限流守卫（审计 SA-25）。
 * `app.module.ts` 以 `APP_GUARD` 全局挂载 —— 本 Phase 是该文件的唯一改动者。
 *
 * 职责极薄（策略全在 `global-rate-limit.policy.ts`，纯函数可单测）：
 *   1. 取计划（豁免 / 桶 + 阈值 + 键）；
 *   2. 豁免 → **直接放行，不产生任何 Redis 操作**（健康探针不得因限流器而增加依赖调用）；
 *   3. 计数超限 → `AppError(RATE_LIMITED)` → 统一异常过滤器映射 429。
 *
 * 与既有 `RateLimitGuard` 的区别（两者**并存不冲突**）：
 *   - 前者按端点显式 `@RateLimit` 配置、默认键 `name:userId|ip`；
 *   - 本守卫对所有 HTTP 路由生效、键为 `global:{bucket}:{ip}:{method}:{route}`；
 *   - 键空间不同 → 既有端点限额不会被"同一计数器计两次"而腰斩。
 *
 * 降级：`RateLimitService.consume` 在 Redis 不可用/超时时 **fail-open**（放行 + 告警）——
 * 限流是保护面，不把基础设施故障放大为全站不可用（既有 M7-P9/Pre-M9 G4 口径，本 Phase 不改变）。
 */
@Injectable()
export class GlobalRateLimitGuard implements CanActivate {
  private readonly logger = new Logger('GlobalRateLimit');

  // 显式 @Inject（与仓库既有约定一致：vitest/esbuild 转译不产出 design:paramtypes，
  // 隐式按类型注入会在 e2e 下拿到 undefined —— 见既有 RateLimitGuard）
  constructor(@Inject(RateLimitService) private readonly limiter: RateLimitService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // 非 HTTP 上下文（未来 WS/RPC）不参与 HTTP 限流
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<Request>();

    const config = globalRateLimitConfig();
    if (config.relaxed && !relaxedWarned) {
      relaxedWarned = true;
      const { read, write, auth, upload } = config.limits;
      this.logger.warn(
        `全局限流阈值按非生产环境放宽（NODE_ENV=${process.env.NODE_ENV ?? 'unset'}，倍数 ${read / 300}）：`
        + `read ${read}/min、write ${write}/min、auth ${auth}/min、upload ${upload}/min、window ${config.windowMs}ms；`
        + '生产默认 300/60/30/30 per min；显式设置 GLOBAL_RATE_LIMIT_* 即按显式值生效',
      );
    }

    const plan = evaluateGlobalRateLimit(req as unknown as RateLimitRequestLike);
    // 豁免：不计数、不落 Redis（探针/预检/webhook/长连接——见策略文件头）
    if (plan.exempt) return true;

    const ok = await this.limiter.consume(plan.key, plan.limit, plan.windowMs);
    if (!ok) {
      // 文案与路由级限流一致：客户端无需区分是哪一层限流（避免泄露阈值结构）
      throw new AppError(ErrorCode.RATE_LIMITED, '请求过于频繁，请稍后再试');
    }
    return true;
  }
}
