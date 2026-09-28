import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { KVStore } from './kv-store.interface';
import { boundedRedisOptions, isRedisTimeoutError, redisCallDeadlineMs, withDeadline } from '../redis/redis-resilience';

/**
 * KV 存储（熔断状态 / 登录失败计数 / 会话锁）。
 *
 * Pre-M9 G4：本类是全站最早的一批 Redis 客户端，原用 `maxRetriesPerRequest: null`
 * ——Redis 不可达时命令 **永不 settle**，登录锁、chat 锁、熔断判定会一起挂住（进程只能强杀）。
 * 现在统一为「命令超时 + 有界重试 + 调用面兜底」：
 * - 客户端侧：`boundedRedisOptions()`（connectTimeout/commandTimeout/maxRetriesPerRequest=2）；
 * - 调用面：每个方法再套 `withDeadline`（命令超时 + 宽限），**离线队列滞留**同样有界；
 * - 失败**显式抛出**（`RedisTimeoutError` 或 ioredis 错误），由调用点决定 fail-open / fail-closed
 *   （各路径理由见调用点注释：登录锁 fail-open、chat 锁 fail-closed、熔断 best-effort）。
 */
@Injectable()
export class RedisKVService implements KVStore, OnModuleDestroy {
  private readonly logger = new Logger('RedisKV');
  private readonly client: Redis;
  private readonly deadlineMs = redisCallDeadlineMs();

  /** @Optional：单测可注入 fake/hanging client（无参时用 REDIS_URL 建真实连接） */
  constructor(@Optional() client?: Redis) {
    this.client = client ?? new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', boundedRedisOptions());
  }

  /** 统一调用面兜底：成功/失败语义不变，超时抛 RedisTimeoutError（绝不无限挂起） */
  private async run<T>(op: Promise<T>, label: string): Promise<T> {
    try {
      return await withDeadline(op, this.deadlineMs, `kv:${label}`);
    } catch (err) {
      if (isRedisTimeoutError(err)) {
        this.logger.warn(`Redis ${label} 超时（>${this.deadlineMs}ms）→ 显式失败（由调用点裁决降级）`);
      }
      throw err;
    }
  }

  async incr(key: string, ttlSec: number): Promise<number> {
    const n = await this.run(this.client.incr(key), 'incr');
    if (n === 1) await this.run(this.client.expire(key, ttlSec), 'expire');
    return n;
  }

  async get(key: string): Promise<string | null> {
    return this.run(this.client.get(key), 'get');
  }

  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    if (ttlSec) await this.run(this.client.set(key, value, 'EX', ttlSec), 'set');
    else await this.run(this.client.set(key, value), 'set');
  }

  async setNX(key: string, value: string, ttlSec: number): Promise<boolean> {
    return (await this.run(this.client.set(key, value, 'EX', ttlSec, 'NX'), 'setNX')) === 'OK';
  }

  async del(key: string): Promise<void> {
    await this.run(this.client.del(key), 'del');
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
