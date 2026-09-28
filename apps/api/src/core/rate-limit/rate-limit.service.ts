import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { boundedRedisOptions, redisCallDeadlineMs, withDeadline } from '../redis/redis-resilience';

/**
 * M7-P9 速率限制（Redis 滑动窗口计数；固定窗口近似——生产级够用且零外部依赖）：
 * consume(key, limit, windowMs) → 窗口内第 N+1 次拒绝（429 RATE_LIMITED）。
 * 覆盖面：AgentRun 创建 / WorkflowRun 创建 / Approval 决断 / OAuth start+callback / webhook（按 token）/ 反馈提交。
 *
 * Pre-M9 G4：原 `maxRetriesPerRequest: 1` 但**无命令超时**——半开连接下 incr 仍可能长时间不返回
 * （离线队列滞留），请求线程被拖住。现在：客户端走 `boundedRedisOptions`（命令超时 + 有界重试），
 * 调用面再套 `withDeadline`；**降级为 fail-open**（理由：限流是保护面而非业务正确性面，
 * Redis 故障时拒绝全部请求会把"防护设施故障"放大为"全站不可用"；此为已知取舍：Redis 故障期间不限流）。
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger('RateLimit');
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', boundedRedisOptions({ maxRetriesPerRequest: 1 }));
  }

  /** 返回是否放行（false = 超限；Redis 不可用/超时 → 放行，理由见类注释） */
  async consume(key: string, limit: number, windowMs: number): Promise<boolean> {
    const k = `ratelimit:${key}`;
    try {
      const count = await withDeadline(
        (async () => {
          const n = await this.redis.incr(k);
          if (n === 1) await this.redis.pexpire(k, windowMs);
          return n;
        })(),
        redisCallDeadlineMs(),
        `ratelimit:consume:${key}`,
      );
      return count <= limit;
    } catch (err) {
      // Redis 不可用/超时 → 放行（限流是保护面，绝不让基础设施故障放大为业务中断）
      this.logger.warn(`限流器异常/超时（放行）: ${(err as Error).message}`);
      return true;
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
