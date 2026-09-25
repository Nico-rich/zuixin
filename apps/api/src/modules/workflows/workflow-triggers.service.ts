import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { EventBusService } from '../../core/events/event-bus.service';
import { WORKFLOW_QUEUE } from '../../core/queue/queue.module';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowDefinition } from './workflow-types';

const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;

/**
 * M7-P6 触发器（webhook/schedule/event；manual 由 API 直入）：
 * - webhook：HMAC-SHA256 签名（secret AES at rest，校验时解密 + timingSafeEqual）+ timestamp ±5min
 *   + eventId 防重放（WebhookDelivery UNIQUE，重复 → 409 WEBHOOK_REPLAY）；
 * - schedule：BullMQ repeatable job（发布注册/归档注销；e2e 可直调 tickScheduled 模拟触发）；
 * - event：EventBus 订阅 → run（幂等键 = event id 或载荷摘要）。
 * 幂等：所有触发器 → WorkflowRunsService.createRun（唯一键去重，同一触发绝不产生第二个 run）。
 */
@Injectable()
export class WorkflowTriggersService implements OnModuleInit {
  private readonly logger = new Logger('WorkflowTriggers');
  /** 进程内 event 订阅登记（重注册去重） */
  private readonly eventSubscriptions = new Map<string, Set<string>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(EventBusService) private readonly events: EventBusService,
    @Inject(WorkflowRunsService) private readonly runs: WorkflowRunsService,
    @InjectQueue(WORKFLOW_QUEUE) private readonly workflowQueue: Queue,
  ) {}

  /** 启动自愈：已发布且带 schedule/event 触发器的工作流重新注册（重启后调度不丢） */
  async onModuleInit(): Promise<void> {
    const published = await this.prisma.workflow.findMany({
      where: { status: 'published' },
      include: { versions: { where: { status: 'published' }, orderBy: { version: 'desc' }, take: 1 } },
    }).catch(() => []);
    for (const wf of published) {
      const def = wf.versions[0]?.definition as unknown as WorkflowDefinition | undefined;
      if (!def) continue;
      for (const t of def.triggers ?? []) {
        if (t.type === 'schedule' && t.cron) await this.registerSchedule(wf.id, t.cron).catch(() => undefined);
        if (t.type === 'event' && t.event) await this.registerEvent(wf.id, t.event);
      }
    }
    this.logger.log({ count: published.length }, '已恢复 published 工作流的 schedule/event 触发器');
  }

  /** 发布时注册（webhook 行 / schedule repeatable / event 订阅） */
  async registerTriggers(workflowId: string, definition: WorkflowDefinition): Promise<{ webhook: { token: string; secret: string | null } | null }> {
    let webhook: { token: string; secret: string | null } | null = null;
    for (const t of definition.triggers ?? []) {
      if (t.type === 'webhook') webhook = await this.ensureWebhook(workflowId);
      if (t.type === 'schedule' && t.cron) await this.registerSchedule(workflowId, t.cron);
      if (t.type === 'event' && t.event) await this.registerEvent(workflowId, t.event);
    }
    return { webhook };
  }

  /** 归档/删除时注销 */
  async unregisterTriggers(workflowId: string, definition: WorkflowDefinition): Promise<void> {
    for (const t of definition.triggers ?? []) {
      if (t.type === 'schedule' && t.cron) await this.removeSchedule(workflowId);
      if (t.type === 'event' && t.event) await this.unregisterEvent(workflowId, t.event);
    }
  }

  /** webhook 端点凭据：首次生成（secret 仅此时返回明文一次）；后续发布返回既有 token（secret=null） */
  async ensureWebhook(workflowId: string): Promise<{ token: string; secret: string | null }> {
    const existing = await this.prisma.workflowWebhook.findFirst({ where: { workflowId, enabled: true } });
    if (existing) return { token: existing.token, secret: null };
    const token = randomBytes(16).toString('hex');
    const secret = randomBytes(32).toString('hex');
    await this.prisma.workflowWebhook.create({
      data: { workflowId, token, secretEncrypted: this.crypto.encrypt(secret) },
    });
    this.logger.log({ workflowId }, 'webhook 凭据已生成（secret 仅返回一次）');
    return { token, secret };
  }

  /** 签名 + timestamp + 防重放验证（任何失败均不泄露内部细节） */
  async verifyWebhook(token: string, rawBody: Buffer, headers: { signature?: string; timestamp?: string; eventId?: string }): Promise<{ workflowId: string; eventId: string }> {
    const webhook = await this.prisma.workflowWebhook.findUnique({ where: { token } });
    if (!webhook || !webhook.enabled) throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'webhook 不存在或已禁用');
    const secret = this.crypto.decrypt(webhook.secretEncrypted);
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = headers.signature ?? '';
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, '签名校验失败');
    }
    const ts = Number(headers.timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
      throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'timestamp 超出允许窗口');
    }
    const eventId = headers.eventId ?? randomUUID();
    // 防重放：同一 eventId 只接受一次（UNIQUE 约束为最终防线）
    try {
      await this.prisma.webhookDelivery.create({
        data: {
          webhookId: webhook.id, eventId,
          payloadHash: createHash('sha256').update(rawBody).digest('hex'),
          status: 'accepted',
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        await this.prisma.webhookDelivery.create({
          data: {
            webhookId: webhook.id, eventId: `${eventId}:dup:${Date.now()}`,
            payloadHash: createHash('sha256').update(rawBody).digest('hex'),
            status: 'duplicate',
          },
        }).catch(() => undefined);
        throw new AppError(ErrorCode.WEBHOOK_REPLAY, '重复的 webhook 事件');
      }
      throw err;
    }
    return { workflowId: webhook.workflowId, eventId };
  }

  /** webhook 载荷 → workflow run（幂等键 = sha256(workflowId:eventId)） */
  async handleWebhook(token: string, rawBody: Buffer, headers: { signature?: string; timestamp?: string; eventId?: string }): Promise<{ runId: string }> {
    const { workflowId, eventId } = await this.verifyWebhook(token, rawBody, headers);
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawBody.toString('utf8'));
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'webhook 载荷必须是 JSON');
    }
    const wf = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!wf) throw new AppError(ErrorCode.NOT_FOUND, '工作流不存在');
    const idempotencyKey = createHash('sha256').update(`${workflowId}:${eventId}`).digest('hex');
    const run = await this.runs.createRun(wf.userId, {
      workflowId, triggerType: 'webhook', triggerId: eventId, idempotencyKey, payload,
    });
    await this.prisma.workflowWebhook.update({ where: { token }, data: { lastDeliveredAt: new Date() } }).catch(() => undefined);
    return { runId: run.id };
  }

  async registerSchedule(workflowId: string, cron: string): Promise<void> {
    await this.workflowQueue.add(
      'scheduled',
      { kind: 'scheduled', workflowId },
      { jobId: `wf-sched-${workflowId}`, repeat: { pattern: cron }, removeOnComplete: true, removeOnFail: true },
    ).catch((err) => this.logger.warn({ workflowId, cron }, `schedule 注册失败: ${(err as Error).message}`));
    this.logger.log({ workflowId, cron }, 'schedule 触发器已注册');
  }

  async removeSchedule(workflowId: string): Promise<void> {
    const jobs = await this.workflowQueue.getRepeatableJobs();
    for (const j of jobs) {
      if (j.id === `wf-sched-${workflowId}`) {
        await this.workflowQueue.removeRepeatableByKey(j.key);
      }
    }
  }

  /** 调度触发（repeatable job 消费；e2e 直调模拟）——幂等键 = 1 分钟时间桶 */
  async tickScheduled(workflowId: string): Promise<void> {
    const wf = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!wf || wf.status !== 'published') return;
    const bucket = Math.floor(Date.now() / 60_000);
    await this.runs.createRun(wf.userId, {
      workflowId, triggerType: 'schedule', triggerId: `sched:${bucket}`,
      idempotencyKey: `sched:${workflowId}:${bucket}`,
    });
    this.logger.log({ workflowId, bucket }, 'schedule 触发 → 创建 workflow run');
  }

  /** event 触发订阅（幂等键 = event.id 或载荷摘要） */
  async registerEvent(workflowId: string, channel: string): Promise<void> {
    const key = channel;
    if (this.eventSubscriptions.get(key)?.has(workflowId)) return;
    if (!this.eventSubscriptions.has(key)) {
      this.eventSubscriptions.set(key, new Set());
      await this.events.subscribe(key, (event) => {
        for (const wfId of this.eventSubscriptions.get(key) ?? []) {
          void this.handleEvent(wfId, event).catch(() => undefined);
        }
      });
    }
    this.eventSubscriptions.get(key)!.add(workflowId);
  }

  async unregisterEvent(workflowId: string, channel: string): Promise<void> {
    this.eventSubscriptions.get(channel)?.delete(workflowId);
  }

  async handleEvent(workflowId: string, event: Record<string, unknown>): Promise<void> {
    const wf = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!wf || wf.status !== 'published') return;
    const eventId = (event.id as string | undefined) ?? createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 16);
    await this.runs.createRun(wf.userId, {
      workflowId, triggerType: 'event', triggerId: eventId,
      idempotencyKey: `event:${workflowId}:${eventId}`,
      payload: event,
    });
    this.logger.log({ workflowId, eventId }, 'event 触发 → 创建 workflow run');
  }
}
