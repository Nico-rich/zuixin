import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { boundedRedisOptions, redisCallDeadlineMs, withDeadline } from '../core/redis/redis-resilience';
import { LLMManagerService } from './llm/llm-manager.service';
import { ImageManagerService } from './image/image-manager.service';
import { VideoManagerService } from './video/video-manager.service';
import { EmbeddingManagerService } from './embedding/embedding-manager.service';

/**
 * M13+（模型配置页）**跨进程 provider 配置传播**（pub/sub channel 名是跨 Agent 契约，不可改）。
 *
 * 为什么需要：providers-admin 的 PATCH 热 refresh 只重建**本进程**（API）的 manager 内存映射；
 * Worker 进程持有自己的 provider adapter 表——不传播则"用户在页面启用 DeepSeek → 路由决策（DB 真相）
 * 选中它 → Worker 的 resolve() 因映射缺失抛 PROVIDER_CONFIG_INVALID"。本服务让 PATCH 后
 * 所有进程（API 各实例 + Worker）在订阅回调里按 type 刷新对应 manager，**配置立即全实例生效**。
 *
 * 降级口径（同 session-events）：
 * - 发布失败：warn——本实例已本地刷新；其他实例退化为重启生效；
 * - 订阅失败：warn + ready 时自动重订阅（Redis 晚起自愈）；
 * - 坏消息：只 warn 丢弃，绝不打断订阅循环。
 */
export const PROVIDER_CONFIG_CHANNEL = 'provider-config';

export type ProviderTypeName = 'llm' | 'image' | 'video' | 'embedding';

export interface ProviderConfigEvent {
  type: ProviderTypeName;
  /** 发布者实例 id（诊断用） */
  instanceId: string;
  at: number;
}

@Injectable()
export class ProviderConfigBusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ProviderConfigBus');
  readonly instanceId = randomUUID();
  private readonly command: Redis;
  private readonly subscriber: Redis;
  private readonly deadlineMs = redisCallDeadlineMs();
  private subscribed = false;

  /**
   * @Optional 客户端注入：单测给假实现（无参时按 REDIS_URL 建真实连接）。
   * 两条连接必须：订阅模式的连接不能再跑普通命令（Redis 协议限制）。
   */
  constructor(
    @Optional() command?: Redis,
    @Optional() subscriber?: Redis,
    @Inject(LLMManagerService) private readonly llm?: LLMManagerService,
    @Inject(ImageManagerService) private readonly image?: ImageManagerService,
    @Inject(VideoManagerService) private readonly video?: VideoManagerService,
    @Inject(EmbeddingManagerService) private readonly embedding?: EmbeddingManagerService,
  ) {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.command = command ?? new Redis(url, boundedRedisOptions());
    this.subscriber = subscriber ?? new Redis(url, boundedRedisOptions({ enableOfflineQueue: false }));
  }

  onModuleInit(): void {
    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel !== PROVIDER_CONFIG_CHANNEL) return;
      const event = this.parse(message);
      if (event) void this.refreshFor(event.type);
    });
    this.subscriber.on('ready', () => {
      this.subscribed = false;
      void this.subscribe();
    });
    this.subscriber.on('error', (err: Error) => this.logger.warn(`provider-config 订阅连接错误（跨进程配置传播降级）: ${err.message}`));
    void this.subscribe();
  }

  onModuleDestroy(): void {
    this.subscriber.disconnect();
    this.command.disconnect();
  }

  /** PATCH 落库并本地刷新后广播（尽力而为；其他实例订阅后按 type 刷新） */
  async notify(type: ProviderTypeName): Promise<void> {
    const event: ProviderConfigEvent = { type, instanceId: this.instanceId, at: Date.now() };
    try {
      await withDeadline(
        this.command.publish(PROVIDER_CONFIG_CHANNEL, JSON.stringify(event)),
        this.deadlineMs,
        'provider-config:publish',
      );
    } catch (err) {
      this.logger.warn(`provider-config 发布失败（本实例已生效；其他实例重启后生效）: ${(err as Error).message}`);
    }
  }

  /** 测试/诊断：本实例订阅是否已在 Redis 服务端生效（同 session-events 的进程内事实口径） */
  isSubscribed(): boolean { return this.subscribed; }

  private async refreshFor(type: string): Promise<void> {
    const manager = type === 'llm' ? this.llm : type === 'image' ? this.image : type === 'video' ? this.video : type === 'embedding' ? this.embedding : null;
    if (!manager) {
      this.logger.warn(`provider-config 收到未知类型事件（已丢弃）: ${type}`);
      return;
    }
    try {
      await manager.refresh();
    } catch (err) {
      this.logger.warn(`provider-config 刷新失败（重启后生效）: type=${type} err=${(err as Error).message}`);
    }
  }

  private async subscribe(): Promise<void> {
    if (this.subscribed) return;
    try {
      await withDeadline(this.subscriber.subscribe(PROVIDER_CONFIG_CHANNEL), this.deadlineMs, 'provider-config:subscribe');
      this.subscribed = true;
      this.logger.log(`已订阅 provider-config（跨进程 provider 配置传播启用，实例 ${this.instanceId.slice(0, 8)}）`);
    } catch (err) {
      this.logger.warn(`provider-config 订阅失败（跨进程传播降级为重启生效；连接恢复后自动重订阅）: ${(err as Error).message}`);
    }
  }

  private parse(message: string): ProviderConfigEvent | null {
    try {
      const parsed = JSON.parse(message) as Partial<ProviderConfigEvent>;
      if (typeof parsed?.type !== 'string') return null;
      return {
        type: parsed.type as ProviderTypeName,
        instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : 'unknown',
        at: typeof parsed.at === 'number' ? parsed.at : Date.now(),
      };
    } catch {
      this.logger.warn('provider-config 收到无法解析的消息（已丢弃）');
      return null;
    }
  }
}
