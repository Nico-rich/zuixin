import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import Redis from 'ioredis';

const CHANNEL_PREFIX = 'agent:events:';

/** run 观察通道（M6-P6 SSE 订阅；driver/trigger/API 共用——core 层定义避免 worker↔module 依赖） */
export const agentRunChannel = (runId: string) => `agent-run:${runId}`;

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

/**
 * Worker → API 的事件推送总线（Redis Pub-Sub；M5 起接 SSE 任务通道，M6-P6 接 run 观察通道）。
 * 处理器按 channel 登记在内存 Map——subscribe 可多次、unsubscribe 精确移除（SSE 断线清理），
 * 底层 Redis 订阅保持（共享单例总线不释放 channel）。
 */
@Injectable()
export class EventBusService implements OnModuleDestroy {
  private readonly logger = new Logger('EventBus');
  private readonly pub: RedisPubSubLike;
  private readonly sub: RedisPubSubLike;
  private readonly handlers = new Map<string, Set<(event: Record<string, unknown>) => void>>();

  constructor(@Optional() injected?: RedisPubSubLike) {
    if (injected) {
      this.pub = injected; this.sub = injected;
      this.attachDispatcher();
      return;
    }
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.pub = wrapRedis(new Redis(url, { maxRetriesPerRequest: null }));
    this.sub = wrapRedis(new Redis(url, { maxRetriesPerRequest: null }));
    this.attachDispatcher();
  }

  /** 单一 'message' 分发器：按 channel 查 handler 集合逐个调用（异常隔离，不影响其他订阅者） */
  private attachDispatcher(): void {
    this.sub.on('message', (ch, msg) => {
      const set = this.handlers.get(ch);
      if (!set) return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(msg); } catch { return; }
      for (const handler of set) {
        try { handler(event); } catch (err) { this.logger.error(`订阅处理器异常: ${(err as Error).message}`); }
      }
    });
  }

  async publish(channel: string, event: Record<string, unknown>): Promise<void> {
    try { await this.pub.publish(CHANNEL_PREFIX + channel, JSON.stringify(event)); }
    catch (err) { this.logger.error(`事件发布失败: ${(err as Error).message}`); }
  }

  async subscribe(channel: string, handler: (event: Record<string, unknown>) => void): Promise<void> {
    const key = CHANNEL_PREFIX + channel;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
      await this.sub.subscribe(key, () => undefined); // 底层订阅一次；handler 分发出内存 Map 承担
    }
    this.handlers.get(key)!.add(handler);
  }

  /** 精确移除单个 handler（SSE 连接断开清理；底层 Redis 订阅保留——共享总线不释放 channel） */
  unsubscribe(channel: string, handler: (event: Record<string, unknown>) => void): void {
    const key = CHANNEL_PREFIX + channel;
    const set = this.handlers.get(key);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(key);
  }

  onModuleDestroy() { this.pub.disconnect(); this.sub.disconnect(); }
}
