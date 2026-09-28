import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import type { ScheduledJob } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';
import { SCHEDULER_QUEUE } from '../../core/queue/scheduler-queue.module';
import { SchedulerService, SCHEDULED_ACTIVE_STATUSES } from '../../modules/scheduler/scheduler.service';
import { EventPlatformService } from '../../modules/events/event-platform.service';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { ShutdownStep } from '../../lifecycle/lifecycle-registry';

/** M8-P9 stalled 判定：running 行 updatedAt 落后超过 timeoutMs × 该系数（且不短于 3×心跳）判 stalled */
const STALL_FACTOR = 3;
/** M8-P9 心跳间隔上界/下界（timeoutMs/3，钳制到 [500ms, 5s]） */
const HEARTBEAT_MIN_MS = 500;
const HEARTBEAT_MAX_MS = 5_000;
/** M8-P9 巡检周期（默认 60s）与优雅停机等待在途作业的上限（默认 25s，低于 30s 进程兜底） */
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_SHUTDOWN_WAIT_MS = 25_000;

export interface StalledReconcileResult {
  /** 被判 stalled 的作业数（running 无心跳 → dead） */
  reaped: number;
  scanned: number;
}

/**
 * M8-P5 Scheduler worker（队列 concurrency=2；无需 claim/lease——作业是可重入的短任务，
 * 幂等由行状态条件更新保证：只有 pending/scheduled 行会被认领为 running，重复投递自然被挡掉）。
 * 状态机：scheduled → running → completed（recurring：回到 scheduled）｜失败 → attempts+1 →
 * 未超 maxAttempts 则按 backoffMs 重投（新 jobId 变体，避免与仍在 active 的当前 job 撞 id）→
 * 超限 → dead + lastError（绝不无限重试）。超时：timeoutMs 到点判失败（有界调用）。
 *
 * M8-P9 补齐（P5 的"已知边界"）：worker 在 running 期间崩溃 → 行停留 running 的兜底。
 *   - **心跳**：执行期间按 heartbeatMs 刷新 updatedAt（@updatedAt），使"活着"可被外部观测；
 *   - **stalled 巡检**：running 且 updatedAt 落后 > max(timeoutMs×3, 3×心跳) → 判 **dead**（终态 failed
 *     语义）+ lastError 留痕 + 事件落库；**绝不自动重投**——一致性优先：running 期间进程崩溃时
 *     无法证明作业没有产生副作用，自动重投会冒"同一作业执行两次"的风险（人工 resume 走显式路径）；
 *   - **优雅停机**：等在途作业收尾（有界，默认 25s），而不是直接丢弃。
 */
@Processor(SCHEDULER_QUEUE, { concurrency: Number(process.env.SCHEDULER_WORKER_CONCURRENCY ?? 2) })
@Injectable()
export class SchedulerProcessor extends WorkerHost implements OnApplicationShutdown, OnModuleInit {
  private readonly logger = new Logger('SchedulerWorker');
  private readonly inFlight = new Set<string>();
  private shuttingDown = false;
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EventPlatformService) private readonly events: EventPlatformService,
  ) {
    super();
  }

  /** M8-P9：启动 stalled 巡检定时器（仅 Worker 进程挂载本 processor）；unref 不阻塞进程退出 */
  onModuleInit(): void {
    const intervalMs = Number(process.env.SCHEDULER_RECONCILE_INTERVAL_MS ?? DEFAULT_RECONCILE_INTERVAL_MS);
    const every = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_RECONCILE_INTERVAL_MS;
    this.reconcileTimer = setInterval(() => {
      if (this.shuttingDown) return;
      void this.reconcileStalled().catch((err) => this.logger.warn(`stalled 巡检失败: ${(err as Error).message}`));
    }, every);
    this.reconcileTimer.unref?.();
  }

  /**
   * M8-P9 Stalled 巡检（幂等，多 Worker 并安全）：running 且心跳过期 → dead（终态失败，不重投）。
   * 条件更新保证只有一个 worker 能判死同一行；已经完成/已重投的行不受影响。
   */
  async reconcileStalled(): Promise<StalledReconcileResult> {
    const now = Date.now();
    const rows = await this.prisma.scheduledJob.findMany({ where: { status: 'running' } });
    let reaped = 0;
    for (const row of rows) {
      const heartbeatMs = Math.min(Math.max(Math.trunc(row.timeoutMs / 3), HEARTBEAT_MIN_MS), HEARTBEAT_MAX_MS);
      const threshold = Math.max(row.timeoutMs * STALL_FACTOR, heartbeatMs * STALL_FACTOR);
      const lag = now - row.updatedAt.getTime();
      if (lag <= threshold) continue;
      const done = await this.prisma.scheduledJob.updateMany({
        where: { id: row.id, status: 'running' }, // 条件更新：与正常完成/重投竞争由 DB 串行裁决
        data: {
          status: 'dead',
          completedAt: new Date(),
          lastError: `stalled：running 期间心跳中断 ${lag}ms（阈值 ${threshold}ms）→ 判失败，不自动重投（人工 resume 走显式路径）`.slice(0, 2000),
        },
      });
      if (done.count === 0) continue;
      reaped++;
      this.logger.error({ jobId: row.id, lag, threshold }, '调度作业心跳中断 → 判 dead（不自动重投，一致性优先）');
      await this.emitEvent('scheduler.job.dead', row, row.attempts);
    }
    if (reaped > 0) this.logger.warn({ reaped, scanned: rows.length }, 'stalled 巡检完成');
    return { reaped, scanned: rows.length };
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
    // M8-P9 心跳：执行期间刷新 updatedAt，使 stalled 巡检能区分"进程已死"与"作业仍在跑"
    const heartbeatMs = Math.min(Math.max(Math.trunc(row.timeoutMs / 3), HEARTBEAT_MIN_MS), HEARTBEAT_MAX_MS);
    const heartbeat = setInterval(() => {
      void this.prisma.scheduledJob
        .updateMany({ where: { id: jobId, status: 'running' }, data: { updatedAt: new Date() } })
        .catch((err) => this.logger.warn({ jobId }, `调度作业心跳失败: ${(err as Error).message}`));
    }, heartbeatMs);
    heartbeat.unref?.();
    this.logger.log({ jobId, handler: row.handler, attempt, heartbeatMs }, '调度作业开始执行');

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
      clearInterval(heartbeat);
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

  /**
   * M8-P9 优雅停机：停止认领新作业 + 等在途作业收尾（有界）。
   * 等待上限默认 25s（低于 30s 进程兜底）：超时未收尾的作业由 stalled 巡检兜底判 dead，
   * 绝不无限等待（挂住的停机比"少跑一个作业"危害更大）。
   */
  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    if (this.inFlight.size === 0) return;
    const waitMs = Number(process.env.SCHEDULER_SHUTDOWN_WAIT_MS ?? DEFAULT_SHUTDOWN_WAIT_MS);
    const deadline = Date.now() + (Number.isFinite(waitMs) && waitMs > 0 ? waitMs : DEFAULT_SHUTDOWN_WAIT_MS);
    this.logger.log({ count: this.inFlight.size, waitMs }, '优雅停机：等待在途调度作业收尾');
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await delay(100).catch(() => undefined);
    }
    if (this.inFlight.size > 0) {
      this.logger.warn({ count: this.inFlight.size }, '优雅停机：在途作业未在等待窗口内收尾 → 交由 stalled 巡检判 dead（不自动重投）');
    } else {
      this.logger.log('优雅停机：在途调度作业已全部收尾');
    }
  }

  /** Pre-M9 G3：有序停机阶段接线（finalizeLeases；幂等——Nest 钩子会再调一次，此时在途集合已空即返回） */
  async onLifecycleStep(step: ShutdownStep): Promise<void> {
    if (step === 'finalizeLeases') await this.onApplicationShutdown();
  }
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
