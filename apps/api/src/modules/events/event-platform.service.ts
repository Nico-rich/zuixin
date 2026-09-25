import { Inject, Injectable, Logger } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { Prisma } from '@prisma/client';
import type { EventEnvelope } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../organizations/authorization.service';
import { EventBusService } from '../../core/events/event-bus.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

export interface PublishEventInput {
  /** 幂等键（生产者提供；同 eventId 只入一次） */
  eventId: string;
  eventType: string;
  version?: number;
  organizationId?: string | null;
  projectId?: string | null;
  actorId?: string | null;
  aggregateType?: string | null;
  aggregateId?: string | null;
  payload?: Record<string, unknown> | null;
  traceId?: string | null;
  occurredAt?: Date | string | number | null;
}

/** 投递给消费者的载荷（含投递次数；事实字段全部来自 EventEnvelope 行） */
export interface EventDelivery {
  eventId: string;
  eventType: string;
  version: number;
  organizationId: string | null;
  projectId: string | null;
  actorId: string | null;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: Date;
  traceId: string | null;
  attempt: number;
}

export interface EventConsumer {
  /** 消费者名（同进程内唯一；重复 subscribe 同名 → 忽略，绝不重复消费） */
  name: string;
  /** 订阅的精确事件类型（P5 不做通配——类型即契约） */
  eventTypes: string[];
  handler: (event: EventDelivery) => Promise<void> | void;
  /** 覆盖默认重试策略（默认 3 次 / 200ms 基数退避） */
  maxAttempts?: number;
  backoffMs?: number;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = 200;
/** 实时通知通道前缀（EventBusService 之上的领域事件通道；与 SSE 观察通道、Timeline 投影互不重叠） */
export const eventChannel = (eventType: string): string => `m8:event:${eventType}`;

/**
 * M8-P5 Event Platform（领域事件层）：
 *
 * 三层职责分离（绝不重叠）：
 * - **EventEnvelope（本服务）= 领域事件事实**：幂等落库（eventId unique）、投递状态机
 *   published → consumed｜failed → dead、重试/死信/重投，是可追溯、可重放的事实源；
 * - **SSE / EventBusService = 实时观察通道**：只把"有事件发生"瞬时推给在线订阅者，
 *   丢一条不影响正确性（表里仍有行）；本服务 publish 后仅用它做实时通知；
 * - **Timeline = 投影**：由消费方从事件表投影出的可读视图，不是另一套事件体系。
 *
 * 幂等与防重放：eventId unique 落库（P2002 → 返回已有行，绝不重复入库/重复通知）；
 * 消费前重读行状态，consumed 直接跳过；成功用条件更新（published/failed → consumed）唯一赢家，
 * 因此重复投递/重复通知/重启补投都绝不产生第二次消费。
 *
 * 边界（P5 明确不做）：多消费者扇出（一个事件被多个消费者各消费一次）需要 per-consumer 投递表，
 * 本阶段 EventEnvelope.status 表达的是"平台级投递"的单消费者语义——同一 eventType 只应有一个消费者。
 */
@Injectable()
export class EventPlatformService {
  private readonly logger = new Logger('EventPlatform');
  /** channel → 消费者集合（进程内登记；重复 subscribe 同名忽略） */
  private readonly consumers = new Map<string, Map<string, EventConsumer>>();
  /** channel → EventBus handler（unsubscribe 需要同一函数引用） */
  private readonly busHandlers = new Map<string, (event: Record<string, unknown>) => void>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthorizationService) private readonly auth: AuthorizationService,
    @Inject(EventBusService) private readonly bus: EventBusService,
  ) {}

  // ===== 发布 =====

  /** 幂等发布：落库为事实 → EventBus 实时通知（通知失败绝不影响事实；重复 eventId 不再通知） */
  async publish(input: PublishEventInput): Promise<{ event: EventEnvelope; created: boolean; consumers: number }> {
    const eventId = (input.eventId ?? '').trim();
    const eventType = (input.eventType ?? '').trim();
    if (!eventId || eventId.length > 160) throw new AppError(ErrorCode.VALIDATION_ERROR, 'eventId 必填且不超过 160 字符');
    if (!eventType || eventType.length > 120) throw new AppError(ErrorCode.VALIDATION_ERROR, 'eventType 必填且不超过 120 字符');

    let event: EventEnvelope;
    try {
      event = await this.prisma.eventEnvelope.create({
        data: {
          eventId,
          eventType,
          version: input.version ?? 1,
          organizationId: input.organizationId ?? null,
          projectId: input.projectId ?? null,
          actorId: input.actorId ?? null,
          aggregateType: input.aggregateType ?? null,
          aggregateId: input.aggregateId ?? null,
          payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
          traceId: input.traceId ?? null,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
          status: 'published',
        },
      });
    } catch (err) {
      // 幂等：同 eventId 已存在 → 复用（返回已有行状态；绝不重复入库、绝不重复通知）
      if ((err as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.eventEnvelope.findUnique({ where: { eventId } });
        if (existing) return { event: existing, created: false, consumers: 0 };
      }
      throw err;
    }

    await this.bus.publish(eventChannel(event.eventType), {
      eventId: event.eventId, eventType: event.eventType, version: event.version,
      organizationId: event.organizationId, projectId: event.projectId, actorId: event.actorId,
      aggregateType: event.aggregateType, aggregateId: event.aggregateId,
      payload: event.payload, occurredAt: event.occurredAt.toISOString(), traceId: event.traceId,
    });
    const consumers = this.consumers.get(eventChannel(event.eventType))?.size ?? 0;
    this.logger.log({ eventId: event.eventId, eventType: event.eventType, consumers }, '领域事件已发布');
    return { event, created: true, consumers };
  }

  // ===== 订阅 / 消费 =====

  /**
   * 订阅（进程内登记；通知 → 按 eventType 分发 → 事实行状态机）。
   * 同一 consumer.name 重复订阅同一类型 → 忽略（绝不重复消费）。
   */
  async subscribe(consumer: EventConsumer): Promise<void> {
    if (!consumer.name) throw new Error('消费者必须有 name');
    if (!consumer.eventTypes?.length) throw new Error('消费者必须声明 eventTypes');
    for (const eventType of consumer.eventTypes) {
      const channel = eventChannel(eventType);
      if (!this.consumers.has(channel)) {
        this.consumers.set(channel, new Map());
        // 每个 channel 仅注册一个总线 handler（进程内串行分发，避免同事件并发消费）
        const handler = (event: Record<string, unknown>) => {
          void this.fanout(channel, String(event.eventId ?? '')).catch((err) =>
            this.logger.error({ channel }, `事件分发异常: ${(err as Error).message}`));
        };
        this.busHandlers.set(channel, handler);
        await this.bus.subscribe(channel, handler);
      }
      const existing = this.consumers.get(channel)!;
      if (existing.has(consumer.name)) {
        this.logger.warn({ name: consumer.name, eventType }, '同名消费者重复订阅，已忽略');
        continue;
      }
      existing.set(consumer.name, consumer);
      this.logger.log({ name: consumer.name, eventType }, '消费者已订阅');
    }
  }

  async unsubscribe(name: string): Promise<void> {
    for (const [channel, set] of this.consumers) {
      set.delete(name);
      if (set.size === 0) {
        const handler = this.busHandlers.get(channel);
        if (handler) this.bus.unsubscribe(channel, handler);
        this.busHandlers.delete(channel);
        this.consumers.delete(channel);
      }
    }
  }

  /** 通道 → 该事件的全部消费者（串行）；以事实行为准，绝不信任通知载荷 */
  private async fanout(channel: string, eventId: string): Promise<void> {
    if (!eventId) return;
    const set = this.consumers.get(channel);
    if (!set || set.size === 0) return;
    for (const consumer of set.values()) {
      await this.deliver(consumer, eventId);
    }
  }

  /** 单消费者投递：状态守卫 + 有界重试（backoff）→ consumed ｜ 超限 → dead */
  async deliver(consumer: EventConsumer, eventId: string): Promise<'consumed' | 'dead' | 'skipped'> {
    const maxAttempts = Math.max(1, consumer.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const backoffMs = consumer.backoffMs ?? DEFAULT_BACKOFF_MS;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const row = await this.prisma.eventEnvelope.findUnique({ where: { eventId } });
      if (!row) return 'skipped';
      if (row.status === 'consumed') return 'skipped'; // 防重放：已消费绝不二次消费
      try {
        await consumer.handler(this.toDelivery(row, attempt));
      } catch (err) {
        const error = (err as Error)?.message ?? String(err);
        if (attempt >= maxAttempts) {
          await this.prisma.eventEnvelope.updateMany({
            where: { eventId, status: { in: ['published', 'failed'] } },
            data: { status: 'dead', attempts: attempt, lastError: error.slice(0, 2000) },
          });
          this.logger.error({ eventId, consumer: consumer.name, attempt, error }, '事件消费失败次数超限 → dead');
          return 'dead';
        }
        await this.prisma.eventEnvelope.updateMany({
          where: { eventId, status: { in: ['published', 'failed'] } },
          data: { status: 'failed', attempts: attempt, lastError: error.slice(0, 2000) },
        });
        this.logger.warn({ eventId, consumer: consumer.name, attempt, error }, '事件消费失败，退避重试');
        if (backoffMs > 0) await delay(backoffMs * attempt, undefined, { ref: false });
        continue;
      }
      // 成功：条件更新（published/failed → consumed）——并发/重复投递下唯一赢家
      const done = await this.prisma.eventEnvelope.updateMany({
        where: { eventId, status: { in: ['published', 'failed'] } },
        data: { status: 'consumed', attempts: attempt, consumedAt: new Date(), lastError: null },
      });
      if (done.count === 0) return 'skipped'; // 已被其他投递消费 → 绝不重复
      this.logger.log({ eventId, consumer: consumer.name, attempt }, '事件已消费');
      return 'consumed';
    }
    return 'skipped';
  }

  private toDelivery(row: EventEnvelope, attempt: number): EventDelivery {
    return {
      eventId: row.eventId, eventType: row.eventType, version: row.version,
      organizationId: row.organizationId, projectId: row.projectId, actorId: row.actorId,
      aggregateType: row.aggregateType, aggregateId: row.aggregateId,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      occurredAt: row.occurredAt, traceId: row.traceId,
      attempt,
    };
  }

  // ===== 查询 / 死信 / 重投 =====

  /** 事件列表（组织维度；orgId 缺省 → 无组织事件；orgId 有值时校验成员身份） */
  async list(
    userId: string,
    opts: { organizationId?: string | null; eventType?: string; status?: string; limit?: number } = {},
  ): Promise<EventEnvelope[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    if (opts.organizationId) await this.auth.require(userId, opts.organizationId);
    return this.prisma.eventEnvelope.findMany({
      where: {
        organizationId: opts.organizationId ?? null,
        ...(opts.eventType ? { eventType: opts.eventType } : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });
  }

  /** 死信列表（status=dead；消费者需人工介入） */
  async deadLetterList(userId: string, opts: { organizationId?: string | null; limit?: number } = {}): Promise<EventEnvelope[]> {
    return this.list(userId, { ...opts, status: 'dead' });
  }

  /**
   * 重投（死信恢复）：dead → published（attempts 归零）→ 重新通知消费者。
   * 已 consumed → 400（绝不二次消费）；非 dead → 400（避免掩盖未决状态）。
   */
  async redeliver(userId: string, eventId: string): Promise<{ event: EventEnvelope; redelivered: boolean; consumers: number }> {
    const row = await this.prisma.eventEnvelope.findUnique({ where: { eventId } });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, '事件不存在');
    if (!row.organizationId) {
      // 无组织事件：仅平台/拥有者可重投（audit 类）；此处按事件表无 owner 字段 → 退化为需登录
      if (!userId) throw new AppError(ErrorCode.FORBIDDEN, '无权重投该事件');
    } else {
      await this.auth.require(userId, row.organizationId);
    }
    if (row.status === 'consumed') throw new AppError(ErrorCode.VALIDATION_ERROR, '事件已消费，不可重投');
    const done = await this.prisma.eventEnvelope.updateMany({
      where: { eventId, status: 'dead' },
      data: { status: 'published', attempts: 0, lastError: null },
    });
    if (done.count === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, `事件不在死信状态（当前 ${row.status}）`);

    const channel = eventChannel(row.eventType);
    const consumers = this.consumers.get(channel)?.size ?? 0;
    for (const consumer of this.consumers.get(channel)?.values() ?? []) {
      await this.deliver(consumer, eventId);
    }
    const fresh = (await this.prisma.eventEnvelope.findUnique({ where: { eventId } })) ?? row;
    this.logger.log({ eventId, consumers }, '死信事件已重投');
    return { event: fresh, redelivered: true, consumers };
  }
}
