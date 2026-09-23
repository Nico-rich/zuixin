import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

const CHANNEL_PREFIX = 'agent:events:';

/** Redis 客户端的最小接口面（测试注入 fake，生产用 wrapRedis 包装 ioredis） */
export interface RedisPubSubLike {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, cb: (ch: string, msg: string) => void): Promise<void>;
  on(event: string, cb: (channel: string, message: string) => void): void;
  disconnect(): void;
}

/** ioredis v5 的 subscribe/on 回调签名与最小接口不一致，显式适配 */
function wrapRedis(raw: Redis): RedisPubSubLike {
  return {
    publish: (ch, msg) => raw.publish(ch, msg),
    subscribe: (ch, cb) => raw.subscribe(ch).then(() => undefined) as Promise<void>,
    on: (event, cb) => { raw.on(event as never, cb as never); },
    disconnect: () => { raw.disconnect(); },
  };
}

/** Worker → API 的事件推送总线（Redis Pub-Sub；M5 起接 SSE 任务通道） */
@Injectable()
export class EventBusService implements OnModuleDestroy {
  private readonly logger = new Logger('EventBus');
  private readonly pub: RedisPubSubLike;
  private readonly sub: RedisPubSubLike;

  constructor(injected?: RedisPubSubLike) {
    if (injected) {
      this.pub = injected; this.sub = injected;
      return;
    }
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.pub = wrapRedis(new Redis(url, { maxRetriesPerRequest: null }));
    this.sub = wrapRedis(new Redis(url, { maxRetriesPerRequest: null }));
  }

  async publish(channel: string, event: Record<string, unknown>): Promise<void> {
    try { await this.pub.publish(CHANNEL_PREFIX + channel, JSON.stringify(event)); }
    catch (err) { this.logger.error(`事件发布失败: ${(err as Error).message}`); }
  }

  async subscribe(channel: string, handler: (event: Record<string, unknown>) => void): Promise<void> {
    await this.sub.subscribe(CHANNEL_PREFIX + channel, (ch, msg) => {
      if (ch !== CHANNEL_PREFIX + channel) return;
      try { handler(JSON.parse(msg)); } catch (err) { this.logger.error(`事件处理失败: ${(err as Error).message}`); }
    });
  }

  onModuleDestroy() { this.pub.disconnect(); this.sub.disconnect(); }
}
