import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

const CHANNEL_PREFIX = 'agent:events:';

/** Worker → API 的事件推送总线（Redis Pub-Sub；M5 起接 SSE 任务通道） */
@Injectable()
export class EventBusService implements OnModuleDestroy {
  private readonly logger = new Logger('EventBus');
  private readonly pub: Redis;
  private readonly sub: Redis;

  constructor(injected?: { publish: (ch: string, msg: string) => Promise<number>; subscribe: (ch: string, cb: (ch: string, msg: string) => void) => Promise<void> }) {
    if (injected) {
      this.pub = injected as Redis; this.sub = injected as Redis;
      return;
    }
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.pub = new Redis(url, { maxRetriesPerRequest: null });
    this.sub = new Redis(url, { maxRetriesPerRequest: null });
  }

  async publish(channel: string, event: Record<string, unknown>): Promise<void> {
    try { await this.pub.publish(CHANNEL_PREFIX + channel, JSON.stringify(event)); }
    catch (err) { this.logger.error(`事件发布失败: ${(err as Error).message}`); }
  }

  async subscribe(channel: string, handler: (event: Record<string, unknown>) => void): Promise<void> {
    await this.sub.subscribe(CHANNEL_PREFIX + channel);
    this.sub.on('message', (ch, msg) => {
      if (ch !== CHANNEL_PREFIX + channel) return;
      try { handler(JSON.parse(msg)); } catch (err) { this.logger.error(`事件处理失败: ${(err as Error).message}`); }
    });
  }

  onModuleDestroy() { this.pub.disconnect(); this.sub.disconnect(); }
}
