import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import type { Prisma, ScheduledJob } from '@prisma/client';
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

/**
 * M11-P7 D2-13（无界载入治理）：stalled 巡检的载入面收窄。
 * - **select 收窄**：只取判定与判死事件需要的事实（不再载入 payload/cron/runAt 等大字段）；
 * - **下推**：逐行阈值 = max(timeoutMs×3, 3×clamp(timeoutMs/3, 500ms, 5s)) 对任意 timeoutMs 的**全局下界**
 *   是 3×HEARTBEAT_MIN_MS = 1500ms（阈值对 timeoutMs 单调不减）⇒ `updatedAt < now - 1500ms` 的谓词
 *   可以在 SQL 侧安全裁剪「心跳必然新鲜」的行，绝不漏掉任何真正 stalled 的行；精确判定仍在逐行分支（timeoutMs 逐行不同）；
 * - **take 分页**：单批 200 行、单周期最多 10 批（按 updatedAt 升序 = 最久无心跳优先），
 *   余量由下个巡检周期（60s）继续——有界工作，绝不因 running 行积压而无界载入。
 */
const RECONCILE_BATCH = 200;
const RECONCILE_MAX_BATCHES = 10;
const STALL_MIN_LAG_MS = HEARTBEAT_MIN_MS * STALL_FACTOR;

/** 巡检投影列（判定 + 判死事件需要的全部列） */
const RECONCILE_SELECT = {
  id: true, type: true, handler: true, timeoutMs: true, updatedAt: true,
  attempts: true, organizationId: true, ownerUserId: true,
} as const;

/** 巡检行（= RECONCILE_SELECT 的投影结果） */
type ReconcileRow = {
  id: string; type: string; handler: string; timeoutMs: number; updatedAt: Date;
  attempts: number; organizationId: string | null; ownerUserId: string | null;
};

/** 事件落库需要的最小行事实（完整 ScheduledJob 行同样满足，process() 复用同一路径） */
type EventRow = Pick<ReconcileRow, 'id' | 'type' | 'handler' | 'organizationId' | 'ownerUserId'>;

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
    // M11-P7 D2-13：心跳新鲜的行（lag ≤ 全局下界 1500ms）在 SQL 侧被裁剪——它们绝不可能是 stalled 行；
    // timeoutMs 逐行不同无法把精确阈值整体下推，故保留逐行判定 + 分页（见文件头注释）。
    const where: Prisma.ScheduledJobWhereInput = { status: 'running', updatedAt: { lt: new Date(now - STALL_MIN_LAG_MS) } };
    let reaped = 0;
    let scanned = 0;
    let cursorId: string | undefined;
    for (let batch = 0; batch < RECONCILE_MAX_BATCHES; batch++) {
      const rows: ReconcileRow[] = await this.prisma.scheduledJob.findMany({
        where,
        select: RECONCILE_SELECT,
        // 最久无心跳优先。注意 updatedAt 会被心跳刷新（可变态）：并发心跳可能让某行的页位置后移，
        // 至多导致它本轮被重复扫描（逐行判定 + 条件更新仍然幂等）或被推迟到下个巡检周期（60s）——
        // 绝不产生错误裁决（裁决者是逐行阈值判定 + 条件更新，不是遍历顺序）。
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: RECONCILE_BATCH,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });
      scanned += rows.length;
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
      const last = rows[rows.length - 1];
      // 末批（不足一批）→ 结束；游标未前进（行被并发删除等）→ 结束（绝不无限循环）
      if (rows.length < RECONCILE_BATCH || !last || last.id === cursorId) break;
      cursorId = last.id;
      if (batch === RECONCILE_MAX_BATCHES - 1) {
        this.logger.warn({ batch: RECONCILE_BATCH, maxBatches: RECONCILE_MAX_BATCHES }, 'stalled 巡检达到单周期分页上限 → 剩余行由下个巡检周期继续');
      }
    }
    if (reaped > 0) this.logger.warn({ reaped, scanned }, 'stalled 巡检完成');
    return { reaped, scanned };
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
  private async emitEvent(eventType: string, row: EventRow, attempt: number): Promise<void> {
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
