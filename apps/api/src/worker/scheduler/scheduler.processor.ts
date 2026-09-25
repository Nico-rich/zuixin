import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import type { ScheduledJob } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';
import { SCHEDULER_QUEUE } from '../../core/queue/scheduler-queue.module';
import { SchedulerService, SCHEDULED_ACTIVE_STATUSES } from '../../modules/scheduler/scheduler.service';
import { EventPlatformService } from '../../modules/events/event-platform.service';
import { PrismaService } from '../../modules/prisma/prisma.service';

/**
 * M8-P5 Scheduler worker（队列 concurrency=2；无需 claim/lease——作业是可重入的短任务，
 * 幂等由行状态条件更新保证：只有 pending/scheduled 行会被认领为 running，重复投递自然被挡掉）。
 * 状态机：scheduled → running → completed（recurring：回到 scheduled）｜失败 → attempts+1 →
 * 未超 maxAttempts 则按 backoffMs 重投（新 jobId 变体，避免与仍在 active 的当前 job 撞 id）→
 * 超限 → dead + lastError（绝不无限重试）。超时：timeoutMs 到点判失败（有界调用）。
 *
 * 已知边界（P5 刻意不做 lease）：worker 在 running 期间进程崩溃 → 行停留在 running，不会自动重投
 * （需人工 resume/cancel 或后续 reconciler 按 updatedAt 兜底）；一致性优先于自动恢复——
 * 宁可停下也不冒"同一作业执行两次"的风险。
 */
@Processor(SCHEDULER_QUEUE, { concurrency: Number(process.env.SCHEDULER_WORKER_CONCURRENCY ?? 2) })
@Injectable()
export class SchedulerProcessor extends WorkerHost implements OnApplicationShutdown {
  private readonly logger = new Logger('SchedulerWorker');
  private readonly inFlight = new Set<string>();
  private shuttingDown = false;

  constructor(
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EventPlatformService) private readonly events: EventPlatformService,
  ) {
    super();
  }

  async process(job: Job<{ jobId?: string }>): Promise<void> {
    const jobId = job.data?.jobId;
    if (!jobId) return; // 非法 payload → 直接完成（绝不猜测）
    const row = await this.prisma.scheduledJob.findUnique({ where: { id: jobId } });
    if (!row) return; // 行已被删除 → 无事实可执行
    if (this.shuttingDown) return; // 优雅停机：不认领新作业（BullMQ 会在关闭后重新投递）

    // 认领（条件更新：只有活跃态可入 running；cancelled/paused/dead/completed 一律跳过）
    const claimed = await this.prisma.scheduledJob.updateMany({
      where: { id: jobId, status: { in: [...SCHEDULED_ACTIVE_STATUSES] } },
      data: { status: 'running', attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      this.logger.debug({ jobId, status: row.status }, '作业不在活跃态，跳过执行');
      return;
    }
    const attempt = row.attempts + 1;
    this.inFlight.add(jobId);
    this.logger.log({ jobId, handler: row.handler, attempt }, '调度作业开始执行');

    const handler = this.scheduler.getHandler(row.handler);
    if (!handler) {
      // 安全底线：未注册 handler 绝不执行（也绝不求值字符串）→ 按失败处理
      await this.onFailure(row, attempt, `handler 未注册：${row.handler}`);
      return;
    }

    try {
      await this.withTimeout(
        Promise.resolve(handler({
          jobId: row.id, name: row.name, handler: row.handler, attempt,
          payload: (row.payload as Record<string, unknown> | null) ?? null,
          organizationId: row.organizationId, traceId: row.traceId,
        })),
        row.timeoutMs,
        `作业执行超时（>${row.timeoutMs}ms）`,
      );
    } catch (err) {
      await this.onFailure(row, attempt, message(err));
      return;
    } finally {
      this.inFlight.delete(jobId);
    }

    // 成功：recurring 回到 scheduled（保持活跃，等待下一次 repeatable 触发）；其余 → completed
    const now = new Date();
    if (row.type === 'recurring') {
      await this.prisma.scheduledJob.updateMany({
        where: { id: row.id, status: 'running' },
        data: { status: 'scheduled', attempts: 0, lastError: null, scheduledAt: now },
      });
    } else {
      await this.prisma.scheduledJob.updateMany({
        where: { id: row.id, status: 'running' },
        data: { status: 'completed', completedAt: now, lastError: null },
      });
    }
    this.logger.log({ jobId: row.id, attempt }, '调度作业执行完成');
    await this.emitEvent('scheduler.job.completed', row, attempt);
  }

  /** 失败：attempts 已自增 → 未超限则按 backoffMs 重投；超限 → dead（lastError 留痕） */
  private async onFailure(row: ScheduledJob, attempt: number, error: string): Promise<void> {
    const jobId = row.id;
    const terminal = attempt >= row.maxAttempts;
    await this.prisma.scheduledJob.updateMany({
      where: { id: jobId, status: 'running' },
      data: { status: terminal ? 'dead' : 'scheduled', lastError: error.slice(0, 2000), ...(terminal ? { completedAt: new Date() } : {}) },
    });
    this.inFlight.delete(jobId);
    if (terminal) {
      this.logger.error({ jobId, attempt, error }, '调度作业失败次数超限 → dead');
      await this.emitEvent('scheduler.job.dead', row, attempt);
      return;
    }
    const backoff = Math.max(0, row.backoffMs) * attempt;
    this.logger.warn({ jobId, attempt, backoff }, '调度作业失败，按退避重投');
    // 重投：新 jobId 变体（当前 job 仍 active，同 id add 会被 BullMQ 判重丢弃）
    await this.scheduler.enqueueRetry(jobId, backoff, attempt).catch((err) =>
      this.logger.error({ jobId }, `重投递失败（行仍为 scheduled，可由人工触发）: ${(err as Error).message}`));
  }

  /** 作业生命周期事件经事件平台落库（eventId 含 attempt → 天然幂等；失败绝不影响作业状态机） */
  private async emitEvent(eventType: string, row: ScheduledJob, attempt: number): Promise<void> {
    try {
      await this.events.publish({
        eventId: `sched:${row.id}:${attempt}:${eventType}`,
        eventType,
        organizationId: row.organizationId,
        actorId: row.ownerUserId,
        aggregateType: 'scheduled_job',
        aggregateId: row.id,
        payload: { jobId: row.id, type: row.type, attempt, handler: row.handler },
      });
    } catch (err) {
      this.logger.warn({ jobId: row.id }, `作业事件落库失败: ${(err as Error).message}`);
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    const timer = delay(timeoutMs, undefined, { ref: false }).then(() => {
      throw new Error(message);
    });
    return Promise.race([promise, timer]) as Promise<T>;
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    // 可重入作业：不等待在途任务（行状态由下一次投递/人工恢复），只记录
    if (this.inFlight.size > 0) this.logger.warn({ count: this.inFlight.size }, '优雅停机：在途调度作业将按行状态兜底');
    await Promise.resolve();
  }
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
