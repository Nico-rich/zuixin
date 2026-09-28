import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { boundedRedisOptions, redisCallDeadlineMs, withDeadline } from '../redis/redis-resilience';

const CHANNEL_PREFIX = 'agent:events:';

/** P5 批量聚合窗口（ms）：窗口内的连续事件合并为一次 pipeline 发布 */
export const EVENT_BATCH_WINDOW_MS = 10;
/** P5 突发上限：缓冲达到该数量立即发布（不等窗口；防长任务无限堆积） */
export const EVENT_BATCH_MAX = 128;
/** 关停时冲刷的最长等待（Redis 不可达绝不阻塞进程退出） */
const DESTROY_FLUSH_TIMEOUT_MS = 200;

/**
 * Pre-M9 G4：单次发布/订阅的调用面兜底上界（默认 = 命令超时 + 500ms 宽限，env 可覆盖）。
 * 理由：事件总线位于 AgentRun 主循环（driver 在 finally 中必须 flush），
 * 若 Redis 半开则 await publish 会永久挂住 → 回合无法收尾、lease 无法释放。
 */
export const EVENT_OP_TIMEOUT_MS = (() => {
  const raw = Number(process.env.EVENT_OP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : redisCallDeadlineMs();
})();

/** run 观察通道（M6-P6 SSE 订阅；driver/trigger/API 共用——core 层定义避免 worker↔module 依赖） */
export const agentRunChannel = (runId: string) => `agent-run:${runId}`;

/** Redis 客户端的最小接口面（测试注入 fake，生产用 wrapRedis 包装 ioredis） */
export interface RedisPubSubLike {
  publish(channel: string, message: string): Promise<number>;
  /** P5 可选：pipeline 批量发布（ioredis pipeline 单往返）；未实现时退化为逐个 publish（语义不变） */
  publishBatch?(entries: Array<{ channel: string; message: string }>): Promise<void>;
  subscribe(channel: string, cb: (ch: string, msg: string) => void): Promise<void>;
  on(event: string, cb: (channel: string, message: string) => void): void;
  disconnect(): void;
}

/** ioredis v5 的 subscribe/on 回调签名与最小接口不一致，显式适配 */
function wrapRedis(raw: Redis): RedisPubSubLike {
  return {
    publish: (ch, msg) => raw.publish(ch, msg),
    // P5：pipeline 批量发布——N 事件 1 次往返（原实现 N 次 await 往返，事件风暴下成为 SSE 推送瓶颈）
    publishBatch: async (entries) => {
      if (!entries.length) return;
      const pipeline = raw.pipeline();
      for (const entry of entries) pipeline.publish(entry.channel, entry.message);
      const results = await pipeline.exec();
      for (const [err] of results ?? []) if (err) throw err; // 逐条错误显式抛出（pipeline 本身不 reject）
    },
    subscribe: (ch, cb) => raw.subscribe(ch).then(() => undefined) as Promise<void>,
    on: (event, cb) => { raw.on(event as never, cb as never); },
    disconnect: () => { raw.disconnect(); },
  };
}

/**
 * Worker → API 的事件推送总线（Redis Pub-Sub；M5 起接 SSE 任务通道，M6-P6 接 run 观察通道）。
 * 处理器按 channel 登记在内存 Map——subscribe 可多次、unsubscribe 精确移除（SSE 断线清理），
 * 底层 Redis 订阅保持（共享单例总线不释放 channel）。
 *
 * P5 批量发布：
 * - 事件先入内存缓冲，**≤10ms 窗口**到点或缓冲达 EVENT_BATCH_MAX 条时，用 pipeline 一次发出
 *   （原实现「一事件一次 await 往返」，Agent 事件风暴下把 SSE 端到端延迟推到 100ms+）；
 * - 顺序与内容不变：缓冲按入队顺序、发送串行化（同一 channel 绝不乱序），JSON 逐条原样；
 * - **强制冲刷**：`flush()` 供流结束/异常路径调用（driver 在 finally 中调用），
 *   模块销毁时也冲刷（带超时上限，Redis 不可达绝不阻塞退出）——最后一批事件绝不因窗口未到而滞留；
 * - 订阅方本地投递不经过缓冲（进程内直发），批量只作用于跨进程发布（Redis pipeline）。
 * 延迟预算：窗口 10ms + pipeline 一次往返 → 端到端 < 50ms（实测见 event-bus.service.spec.ts）。
 */
@Injectable()
export class EventBusService implements OnModuleDestroy {
  private readonly logger = new Logger('EventBus');
  private readonly pub: RedisPubSubLike;
  private readonly sub: RedisPubSubLike;
  private readonly handlers = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  /** 待发布缓冲（跨 channel 共享——发送时按入队顺序，天然保持各 channel 内的相对顺序） */
  private buffer: Array<{ channel: string; message: string }> = [];
  private timer: NodeJS.Timeout | null = null;
  /** 串行化发布链：并发 flush 绝不交错，事件顺序恒定 */
  private chain: Promise<void> = Promise.resolve();

  constructor(@Optional() injected?: RedisPubSubLike) {
    if (injected) {
      this.pub = injected; this.sub = injected;
      this.attachDispatcher();
      return;
    }
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    // Pre-M9 G4：原为 maxRetriesPerRequest: null（命令无限重试 → 半开连接下 await publish 永不返回）。
    // 发布/订阅均为**非阻塞命令**（无 BLPOP 类），可安全启用命令超时 + 有界重试。
    this.pub = wrapRedis(new Redis(url, boundedRedisOptions()));
    this.sub = wrapRedis(new Redis(url, boundedRedisOptions()));
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

  /** 入缓冲（不阻塞调用方）；达到突发上限时立即发布 */
  async publish(channel: string, event: Record<string, unknown>): Promise<void> {
    let message: string;
    try { message = JSON.stringify(event); }
    catch (err) { this.logger.error(`事件序列化失败: ${(err as Error).message}`); return; }
    this.buffer.push({ channel: CHANNEL_PREFIX + channel, message });
    if (this.buffer.length >= EVENT_BATCH_MAX) { await this.flush(); return; }
    this.scheduleFlush();
  }

  /** 强制冲刷（流结束/异常路径/关停）：清窗口定时器并立即发布全部缓冲事件（有界，失败不冒泡） */
  async flush(): Promise<void> {
    this.clearTimer();
    if (!this.buffer.length) { await this.chain; return; }
    const batch = this.buffer;
    this.buffer = [];
    // 串行化：绝不与在途批量并发（同一 channel 的事件顺序恒定）
    this.chain = this.chain.then(() => this.sendBounded(batch)).catch((err) => {
      this.logger.error(`事件发布失败（${batch.length} 条）: ${(err as Error).message}`);
    });
    await this.chain;
  }

  /** 缓冲中的待发布事件数（可观测/测试用） */
  pendingEvents(): number { return this.buffer.length; }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, EVENT_BATCH_WINDOW_MS);
    this.timer.unref?.(); // 绝不因窗口定时器持有进程（测试/关停友好）
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** 发布一批：优先 pipeline（单往返）；未实现时退化为逐个 publish（语义/顺序不变） */
  private async send(batch: Array<{ channel: string; message: string }>): Promise<void> {
    if (!batch.length) return;
    if (this.pub.publishBatch) { await this.pub.publishBatch(batch); return; }
    for (const entry of batch) await this.pub.publish(entry.channel, entry.message);
  }

  /**
   * Pre-M9 G4：带调用面上界的发布。
   * 降级（**fail-open**）：超时/失败仅记录日志并丢弃本批——事件推送是"尽力而为"的实时观察面，
   * **事实源是 DB**（AgentRun timeline 投影 + 事件表）；绝不让 Redis 故障阻塞 AgentRun 收尾、
   * lease 释放或 SSE 线程（原 `maxRetriesPerRequest: null` 下 await publish 可能永不返回）。
   */
  private async sendBounded(batch: Array<{ channel: string; message: string }>): Promise<void> {
    try {
      await withDeadline(this.send(batch), EVENT_OP_TIMEOUT_MS, `event-bus:publish:${batch.length}`);
    } catch (err) {
      this.logger.error(`事件发布失败/超时（${batch.length} 条，降级：丢弃本批，事实源为 DB）: ${(err as Error).message}`);
    }
  }

  /**
   * 订阅（底层 Redis 订阅一次；handler 分发出内存 Map 承担）。
   * Pre-M9 G4：**有界等待 + 显式失败**——订阅建立不上时清掉刚写入的 handler 集合后抛错，
   * 绝不留下"看起来有订阅、实际收不到事件"的半成品状态；调用点据此选择降级（如 SSE 仅推快照）。
   */
  async subscribe(channel: string, handler: (event: Record<string, unknown>) => void): Promise<void> {
    const key = CHANNEL_PREFIX + channel;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
      try {
        await withDeadline(this.sub.subscribe(key, () => undefined), EVENT_OP_TIMEOUT_MS, `event-bus:subscribe:${key}`);
      } catch (err) {
        this.handlers.delete(key); // 订阅未建立 → 不留半成品
        this.logger.error(`事件订阅失败/超时（${key}）: ${(err as Error).message}`);
        throw err;
      }
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

  /** 关停：冲刷缓冲（带超时上限）→ 清空 handler → 断开连接（清理机制，绝不残留订阅/定时器） */
  async onModuleDestroy(): Promise<void> {
    this.clearTimer();
    if (this.buffer.length) {
      await Promise.race([
        this.flush(),
        new Promise((resolve) => { const t = setTimeout(resolve, DESTROY_FLUSH_TIMEOUT_MS); t.unref?.(); }),
      ]);
    }
    this.handlers.clear();
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
