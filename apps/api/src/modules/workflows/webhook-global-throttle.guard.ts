import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { RateLimitService } from '../../core/rate-limit/rate-limit.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/**
 * M10-P5 SA-16/SA-17：webhook 的**全局总闸**（与既有 per-token `@RateLimit` 并存，构成两道闸）。
 *
 * 为什么 per-token 不够：per-token 的键取自 URL 路径里的 token 本身，
 * 于是**不持有效 token 的人可以自由换 token**（甚至每次随机）→ 该维度对"未知 token 风暴"零约束，
 * 而每个请求都要查库 + 解密 + HMAC 比对，是最廉价可放大的攻击面。
 * 全局键与 token/IP 无关 → 无论请求怎么变，单位时间内的 webhook 处理总量都有硬上界。
 *
 * 语义（与 A8 的全局 per-IP 限流是不同维度：本闸只覆盖 webhook 端点）：
 * - 键 = 固定 `webhook:global`（全站共享单一计数桶）；
 * - 超限 → `AppError(RATE_LIMITED)` → HTTP 429（与既有 RateLimitGuard 同一错误码/映射，客户端行为一致）；
 * - Redis 不可用 → **放行**：沿用 RateLimitService 既有 fail-open 取舍
 *   （限流是保护面，绝不把 Redis 抖动放大成"webhook 全挂"）。
 *
 * 阈值取"背压"而非"配额"：默认远高于单 token 的 120/min，正常多租户流量不受影响，只在异常风暴时兜底。
 * 取舍（已知）：全局桶天然是共享资源——持续超量的发送方会挤占其他租户的额度；
 * 因此默认值定得足够宽松，且可用 env 调整（必要时可在后续 Phase 细分维度）。
 * 本文件只**消费** RateLimitService 既有能力，不改 `core/rate-limit/**`（A8 所有）。
 */
export const WEBHOOK_GLOBAL_KEY = 'webhook:global';
/** 默认 3000 次/分钟（≈50/s；单 token 上限 120/min 的 25 倍，仅为背压兜底） */
export const WEBHOOK_GLOBAL_LIMIT_DEFAULT = 3_000;
export const WEBHOOK_GLOBAL_WINDOW_MS_DEFAULT = 60_000;

/** 全局闸阈值（env WEBHOOK_GLOBAL_LIMIT 可覆盖；非法/缺失 → 默认值）——请求时读取，便于测试注入 */
export function webhookGlobalLimit(): number {
  const raw = Number(process.env.WEBHOOK_GLOBAL_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : WEBHOOK_GLOBAL_LIMIT_DEFAULT;
}

/** 全局闸窗口（env WEBHOOK_GLOBAL_WINDOW_MS 可覆盖；非法/缺失 → 60s） */
export function webhookGlobalWindowMs(): number {
  const raw = Number(process.env.WEBHOOK_GLOBAL_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : WEBHOOK_GLOBAL_WINDOW_MS_DEFAULT;
}

@Injectable()
export class WebhookGlobalThrottleGuard implements CanActivate {
  private readonly logger = new Logger('WebhookGlobalThrottle');

  constructor(@Inject(RateLimitService) private readonly limiter: RateLimitService) {}

  async canActivate(_ctx: ExecutionContext): Promise<boolean> {
    const limit = webhookGlobalLimit();
    const windowMs = webhookGlobalWindowMs();
    let ok = true;
    try {
      ok = await this.limiter.consume(WEBHOOK_GLOBAL_KEY, limit, windowMs);
    } catch (err) {
      // defense in depth：RateLimitService 自身已 fail-open，此处再兜一层——
      // 限流设施的任何异常都不得变成"webhook 不可用"。
      this.logger.warn(`webhook 全局闸异常（放行）: ${(err as Error).message}`);
      return true;
    }
    if (!ok) {
      // 观测：只记阈值，绝不记 token/载荷（保持 webhook 面零敏感信息）
      this.logger.warn({ limit, windowMs }, 'webhook 全局速率上限触发（429）');
      throw new AppError(ErrorCode.RATE_LIMITED, 'webhook 请求过于频繁，请稍后再试');
    }
    return true;
  }
}
