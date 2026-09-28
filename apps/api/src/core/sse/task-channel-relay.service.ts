import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { EventBusService } from '../events/event-bus.service';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { SseConnectionInfo, SseConnectionOwner, SseConnectionSink, SseRegistryService } from './sse-registry.service';

/** 转发的 Redis 通道（worker 的 media-generation 发布端既有约定，不改发布端） */
export const TASK_CHANNEL = 'task';

/** 允许转发的线上事件名（shared/events.ts 注册表中的 task.* 子集；payload 原样透传，不新造字段） */
const TASK_EVENT_TYPES = new Set(['task.created', 'task.progress', 'task.completed']);

/** 归属解析缓存 TTL（progress 事件可能高频，避免每条事件一次 DB 往返） */
export const TASK_OWNER_TTL_MS = (() => {
  const raw = Number(process.env.TASK_SSE_OWNER_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 60_000;
})();
/** 归属缓存容量上限（防长跑进程无界增长；超出按插入序淘汰最旧） */
export const TASK_OWNER_CACHE_MAX = 1000;
/** 订阅失败后的重试间隔（Redis 半开/重启后自愈；定时器 unref，绝不持有进程） */
export const TASK_RELAY_RETRY_MS = (() => {
  const raw = Number(process.env.TASK_SSE_RELAY_RETRY_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 30_000;
})();

export interface TaskOwner { userId: string; conversationId: string | null; }

/**
 * 归属匹配（**fail-closed**）：两侧 userId 都已知且相等才可能命中；
 * conversationId 只在**双侧都已知**时要求相等（新建会话的连接拿不到 conversationId → 退化为按 user 匹配，
 * 不因缺少会话维度而丢事件）。user 未知的连接（非 JWT 路径/测试 fake）与越权任务一律不转发。
 */
export function matchesOwner(conn: SseConnectionOwner, task: TaskOwner): boolean {
  if (!conn.userId || conn.userId !== task.userId) return false;
  if (conn.conversationId && task.conversationId && conn.conversationId !== task.conversationId) return false;
  return true;
}

/** 帧格式与 modules/chat/sse-writer 的 SSEWriter 逐字节一致（`event:` 行 + 单行 JSON `data:` + 空行） */
export function writeSseFrame(sink: SseConnectionSink, name: string, data: unknown): void {
  if (typeof sink.write !== 'function') throw new Error('SSE sink 不支持 write');
  sink.write(`event: ${name}\n`);
  sink.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * M10-P13（审计 ARCH-07）：**task 通道 → SSE 转发器**。
 *
 * 背景：worker 早已把任务进度发布到 Redis `task` 通道（media-generation.service），但没有订阅者
 * → 前端只能靠 2s 轮询 GET /tasks/:id 观察进度。本服务订阅该通道，把 `task.progress` / `task.completed`
 * 事件按 owner（user，必要时 conversation）路由到**已注册的 SSE 连接**（chat 流 / run 观察流），
 * 让 TaskCard 从"轮询"升级为"推送优先、轮询兜底"。
 *
 * 边界与降级：
 * - **事实源仍是 DB**：本转发只是尽力而为的观察面加速，事件丢/乱序不改变任何状态；客户端收到信号后仍以
 *   GET /tasks/:id 的结果为准（TaskCard 对账）。不新增队列/不新增表/不改 shared 事件 schema。
 * - **越权不可能**：只按连接归属投递（fail-closed），不广播；不在连接上的 taskId 无法影响他人连接。
 * - **Redis 不可用**：订阅失败 → 标记 degraded + 计数 + 日志，并按 TASK_RELAY_RETRY_MS 重试（前端轮询兜底）。
 * - 不触碰 chat.controller（归属由注册表从 Express res.req 推导）。
 */
@Injectable()
export class TaskChannelRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('TaskSseRelay');
  private readonly owners = new Map<string, TaskOwner & { expiresAt: number }>();
  private handler: ((event: Record<string, unknown>) => void) | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  /** D10 同款降级信号：未建立订阅即视为降级，直到订阅成功 */
  private degraded = true;
  private subscribeFailures = 0;
  private forwarded = 0;
  private skipped = 0;

  constructor(
    @Inject(SseRegistryService) private readonly registry: SseRegistryService,
    @Inject(EventBusService) private readonly bus: EventBusService,
    // @Optional：单测可注入 fake；生产由 @Global PrismaModule 提供
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureSubscribed();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.handler) { this.bus.unsubscribe(TASK_CHANNEL, this.handler); this.handler = null; }
    this.owners.clear();
  }

  /** 订阅是否处于降级（未建立；前端轮询兜底仍可用） */
  isDegraded(): boolean { return this.degraded; }

  /** 可观测信号（降级/失败计数/转发量；不静默降级） */
  stats(): { degraded: boolean; subscribeFailures: number; forwarded: number; skipped: number; cachedOwners: number } {
    return { degraded: this.degraded, subscribeFailures: this.subscribeFailures, forwarded: this.forwarded, skipped: this.skipped, cachedOwners: this.owners.size };
  }

  /** 建立订阅（幂等）；失败 → degraded + 计数 + 日志 + 定时重试 */
  private async ensureSubscribed(): Promise<boolean> {
    if (this.handler) return true;
    const handler = (event: Record<string, unknown>) => { void this.onTaskEvent(event); };
    try {
      await this.bus.subscribe(TASK_CHANNEL, handler);
      this.handler = handler;
      this.degraded = false;
      this.logger.log(`task 通道转发已订阅（worker → SSE：task.progress/task.completed 按 owner 路由）`);
      return true;
    } catch (err) {
      this.subscribeFailures++;
      this.degraded = true;
      this.logger.error(`task 通道订阅失败（第 ${this.subscribeFailures} 次，降级：任务进度退回前端轮询）: ${(err as Error).message}`);
      this.scheduleRetry();
      return false;
    }
  }

  private scheduleRetry(): void {
    if (this.destroyed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.ensureSubscribed();
    }, TASK_RELAY_RETRY_MS);
    this.retryTimer.unref?.();
  }

  /** 单条事件处理：识别 → 归属解析 → 定向投递（任何异常都不冒泡到事件总线） */
  private async onTaskEvent(event: Record<string, unknown>): Promise<void> {
    try {
      const type = typeof event.type === 'string' ? event.type : '';
      const taskId = typeof event.taskId === 'string' ? event.taskId : '';
      if (!TASK_EVENT_TYPES.has(type) || !taskId) { this.skipped++; return; }
      const owner = await this.resolveOwner(taskId);
      if (!owner) { this.skipped++; return; } // 未知任务/解析失败 → fail-closed（不广播）
      const delivered = this.registry.deliver(
        (info: SseConnectionInfo) => matchesOwner(info, owner),
        (sink) => writeSseFrame(sink, type, event),
      );
      if (delivered > 0) this.forwarded += delivered;
      else this.skipped++;
    } catch (err) {
      this.logger.warn(`task 事件转发失败（降级：本条丢弃，前端轮询兜底）: ${(err as Error).message}`);
    }
  }

  /** taskId → 归属（带 TTL 缓存；查不到即 null） */
  private async resolveOwner(taskId: string): Promise<TaskOwner | null> {
    const cached = this.owners.get(taskId);
    if (cached && cached.expiresAt > Date.now()) return { userId: cached.userId, conversationId: cached.conversationId };
    if (cached) this.owners.delete(taskId);
    if (!this.prisma) return null;
    try {
      const row = await this.prisma.generationTask.findUnique({ where: { id: taskId }, select: { userId: true, conversationId: true } });
      if (!row) return null;
      const owner: TaskOwner = { userId: row.userId, conversationId: row.conversationId ?? null };
      if (this.owners.size >= TASK_OWNER_CACHE_MAX) {
        const oldest = this.owners.keys().next();
        if (!oldest.done) this.owners.delete(oldest.value);
      }
      this.owners.set(taskId, { ...owner, expiresAt: Date.now() + TASK_OWNER_TTL_MS });
      return owner;
    } catch (err) {
      this.logger.warn(`任务归属解析失败（taskId=${taskId}，本条不转发）: ${(err as Error).message}`);
      return null;
    }
  }
}
