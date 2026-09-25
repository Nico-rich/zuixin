import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * M7-P9 速率限制（Redis 滑动窗口计数；固定窗口近似——生产级够用且零外部依赖）：
 * consume(key, limit, windowMs) → 窗口内第 N+1 次拒绝（429 RATE_LIMITED）。
 * 覆盖面：AgentRun 创建 / WorkflowRun 创建 / Approval 决断 / OAuth start+callback / webhook（按 token）/ 反馈提交。
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger('RateLimit');
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
  }

  /** 返回是否放行（false = 超限） */
  async consume(key: string, limit: number, windowMs: number): Promise<boolean> {
    const k = `ratelimit:${key}`;
    try {
      const count = await this.redis.incr(k);
      if (count === 1) await this.redis.pexpire(k, windowMs);
      return count <= limit;
    } catch (err) {
      // Redis 不可用 → 放行（限流是保护面，绝不让基础设施故障放大为业务中断）
      this.logger.warn(`限流器异常（放行）: ${(err as Error).message}`);
      return true;
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
