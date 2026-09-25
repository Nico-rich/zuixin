import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import type { ScheduledJob } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../organizations/authorization.service';
import { SCHEDULER_QUEUE } from '../../core/queue/scheduler-queue.module';
import { AppError, ErrorCode } from '../../common/errors/app-error';

export type ScheduledJobType = 'one-shot' | 'delayed' | 'recurring';
/** 可执行状态（处理器只从这两个状态认领——终态/暂停/取消的行绝不被 BullMQ 残留 job 意外执行） */
export const SCHEDULED_ACTIVE_STATUSES = ['pending', 'scheduled'] as const;

export interface ScheduleJobInput {
  ownerUserId: string;
  organizationId?: string | null;
  name: string;
  /** 服务端注册表标识（绝不执行任意代码；未注册的 handler 在 worker 侧直接判失败） */
  handler: string;
  type?: ScheduledJobType;
  cron?: string | null;
  runAt?: Date | string | number | null;
  payload?: Record<string, unknown> | null;
  priority?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  idempotencyKey?: string | null;
  traceId?: string | null;
}

export interface JobHandlerContext {
  jobId: string;
  name: string;
  handler: string;
  attempt: number;
  payload: Record<string, unknown> | null;
  organizationId: string | null;
  traceId: string | null;
}

export type JobHandler = (ctx: JobHandlerContext) => Promise<void> | void;

const CRON_FIELD = /^(\*|[\d,\-*/]+)$/;
const HANDLER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;

/** 校验归一化结果（runAt 已转 Date；cron 仅 recurring 有值） */
interface NormalizedSchedule extends ScheduleJobInput {
  name: string;
  handler: string;
  type: ScheduledJobType;
  cron: string | null;
  runAt: Date | null;
  priority: number;
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
}

/**
 * M8-P5 Scheduler 服务（API 与 Worker 共用）：
 * - 事实源是 ScheduledJob 行；BullMQ 只是投递通道（行状态才决定"能不能执行"——残留 job 由
 *   SchedulerProcessor 的活跃状态条件认领兜底，绝不出现"取消了还会跑"）；
 * - idempotencyKey 唯一：重复 schedule 直接返回已有行（绝不产生第二个作业）；
 * - one-shot/delayed → delayed job（delay = runAt - now）；recurring → repeatable job（cron pattern）；
 * - handler 注册表：进程内注册（registerHandler），内置 'noop'；worker 遇到未注册 handler → 判失败
 *   （安全底线：绝不动态执行/求值任何字符串）。
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger('Scheduler');
  /** handler 注册表（进程内；API 进程用于自检，worker 进程用于真实执行） */
  private readonly handlers = new Map<string, JobHandler>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthorizationService) private readonly auth: AuthorizationService,
    @InjectQueue(SCHEDULER_QUEUE) private readonly queue: Queue,
  ) {
    this.registerHandler('noop', () => undefined);
  }

  // ===== handler 注册表 =====

  registerHandler(name: string, fn: JobHandler): void {
    if (!HANDLER_NAME.test(name)) throw new Error(`非法 handler 名称：${name}`);
    this.handlers.set(name, fn);
  }

  getHandler(name: string): JobHandler | undefined {
    return this.handlers.get(name);
  }

  listHandlers(): string[] {
    return [...this.handlers.keys()].sort();
  }

  // ===== 调度 =====

  /**
   * 创建调度作业（幂等：同 idempotencyKey → 返回已有行，**不重复入队**）。
   * 幂等命中不重新投递是刻意选择：已有活跃行可能正处在重投（jobId 变体）中，
   * 再补一条首次投递会产生第二次执行——宁可让调用方显式走 resume/cancel 重建。
   */
  async schedule(input: ScheduleJobInput): Promise<{ job: ScheduledJob; created: boolean }> {
    const normalized = this.validate(input);

    if (normalized.idempotencyKey) {
      const existing = await this.prisma.scheduledJob.findUnique({ where: { idempotencyKey: normalized.idempotencyKey } });
      if (existing) return { job: existing, created: false };
    }

    let row: ScheduledJob;
    try {
      row = await this.prisma.scheduledJob.create({
        data: {
          organizationId: normalized.organizationId ?? null,
          ownerUserId: normalized.ownerUserId,
          name: normalized.name,
          type: normalized.type,
          cron: normalized.cron,
          runAt: normalized.runAt,
          status: 'scheduled',
          scheduledAt: normalized.type === 'recurring' ? null : normalized.runAt ?? new Date(),
          priority: normalized.priority,
          timeoutMs: normalized.timeoutMs,
          maxAttempts: normalized.maxAttempts,
          backoffMs: normalized.backoffMs,
          payload: (normalized.payload ?? undefined) as Prisma.InputJsonValue | undefined,
          handler: normalized.handler,
          idempotencyKey: normalized.idempotencyKey,
          traceId: normalized.traceId,
        },
      });
    } catch (err) {
      // 并发同键 → P2002：复用赢家行（幂等语义；绝不第二个作业）
      if ((err as { code?: string }).code === 'P2002' && normalized.idempotencyKey) {
        const won = await this.prisma.scheduledJob.findUnique({ where: { idempotencyKey: normalized.idempotencyKey } });
        if (won) return { job: won, created: false };
      }
      throw err;
    }

    try {
      await this.enqueue(row);
    } catch (err) {
      // 入队失败 → 回滚行（不留下"看似已调度、永不执行"的孤儿事实）
      await this.prisma.scheduledJob.delete({ where: { id: row.id } }).catch(() => undefined);
      this.logger.error({ jobId: row.id }, `调度入队失败: ${(err as Error).message}`);
      throw err;
    }
    this.logger.log({ jobId: row.id, type: row.type, handler: row.handler }, '调度作业已创建');
    return { job: row, created: true };
  }

  /** 投递到 BullMQ：one-shot/delayed → delayed job；recurring → repeatable job */
  private async enqueue(row: ScheduledJob, delayOverrideMs?: number): Promise<void> {
    if (row.type === 'recurring') {
      if (!row.cron) throw new AppError(ErrorCode.VALIDATION_ERROR, 'recurring 作业缺少 cron');
      // 作业名 = 行身份（BullMQ 的 repeatable 元数据不保留自定义 jobId，只有 name 可用于精确注销）；
      // 同名同 pattern 重复注册由 BullMQ 去重（pause→resume 重建不会产生第二条）
      await this.queue.add(
        repeatJobId(row.id),
        { jobId: row.id },
        { jobId: repeatJobId(row.id), repeat: { pattern: row.cron }, removeOnComplete: true, removeOnFail: true, priority: row.priority },
      );
      return;
    }
    const delay = delayOverrideMs ?? Math.max(0, (row.runAt?.getTime() ?? Date.now()) - Date.now());
    await this.queue.add(
      'scheduled-job',
      { jobId: row.id },
      { jobId: oneShotJobId(row.id, row.attempts), delay, removeOnComplete: true, removeOnFail: true, priority: row.priority },
    );
  }

  /**
   * 失败重投（worker 退避用）：jobId 用新变体 `sched-{id}-r{attempt}`——当前 job 仍处于 active，
   * 同 id add 会被 BullMQ 判重丢弃（作业就永远卡住）。
   */
  async enqueueRetry(id: string, delayMs: number, attempt: number): Promise<void> {
    await this.queue.add(
      'scheduled-job',
      { jobId: id },
      { jobId: oneShotJobId(id, attempt), delay: Math.max(0, Math.trunc(delayMs)), removeOnComplete: true, removeOnFail: true },
    );
  }

  /** 取消（pending/scheduled/running/paused → cancelled + 移除 BullMQ job）；已 cancelled 幂等返回，其余终态 → 400 */
  async cancel(userId: string, id: string): Promise<{ cancelled: boolean; status: string }> {
    const row = await this.get(userId, id);
    if (row.status === 'cancelled') return { cancelled: true, status: row.status };
    const done = await this.prisma.scheduledJob.updateMany({
      where: { id, status: { in: [...SCHEDULED_ACTIVE_STATUSES, 'running', 'paused'] } },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    if (done.count === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, `作业已终态（${row.status}），不可取消`);
    // 事实源是行（状态守卫兜底），队列清理只是减少无效投递
    if (row.type === 'recurring') await this.removeRepeatable(id);
    else await this.removeQueuedJobs(id);
    this.logger.log({ jobId: id }, '调度作业已取消');
    return { cancelled: true, status: 'cancelled' };
  }

  /**
   * 暂停：
   * - recurring：移除 repeatable（保留行状态 paused）；
   * - one-shot/delayed：状态标记 paused + 移除延迟 job（resume 时按原 runAt 重建）。
   */
  async pause(userId: string, id: string): Promise<{ paused: boolean; status: string }> {
    const row = await this.get(userId, id);
    if (row.status === 'paused') return { paused: true, status: row.status };
    const done = await this.prisma.scheduledJob.updateMany({
      where: { id, status: { in: [...SCHEDULED_ACTIVE_STATUSES] } },
      data: { status: 'paused' },
    });
    if (done.count === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, `作业不可暂停（当前 ${row.status}）`);
    if (row.type === 'recurring') await this.removeRepeatable(id);
    else await this.removeQueuedJobs(id);
    this.logger.log({ jobId: id }, '调度作业已暂停');
    return { paused: true, status: 'paused' };
  }

  /** 恢复（paused → scheduled + 重建 BullMQ job）；非 paused → 400 */
  async resume(userId: string, id: string): Promise<{ resumed: boolean; status: string }> {
    const row = await this.get(userId, id);
    const done = await this.prisma.scheduledJob.updateMany({
      where: { id, status: 'paused' },
      data: { status: 'scheduled', attempts: 0, lastError: null },
    });
    if (done.count === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, `作业不在暂停态（当前 ${row.status}）`);
    const fresh = { ...row, status: 'scheduled', attempts: 0 };
    if (row.type === 'recurring') {
      await this.enqueue(fresh);
    } else {
      // 原 runAt 已过 → 立即执行（delay 0）；未到 → 按剩余时间
      await this.enqueue(fresh, Math.max(0, (row.runAt?.getTime() ?? Date.now()) - Date.now()));
    }
    this.logger.log({ jobId: id }, '调度作业已恢复');
    return { resumed: true, status: 'scheduled' };
  }

  // ===== 查询 =====

  /** 列表：给了 orgId → 校验成员身份后按组织过滤；未给 → 按 owner 过滤（个人作业） */
  async list(userId: string, opts: { organizationId?: string | null; status?: string; limit?: number } = {}): Promise<ScheduledJob[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    if (opts.organizationId) {
      await this.auth.require(userId, opts.organizationId);
      return this.prisma.scheduledJob.findMany({
        where: { organizationId: opts.organizationId, ...(opts.status ? { status: opts.status } : {}) },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        take: limit,
      });
    }
    return this.prisma.scheduledJob.findMany({
      where: { ownerUserId: userId, organizationId: null, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
  }

  /** 单行读取 + 归属校验（组织作业 → membership；个人作业 → owner 本人） */
  async get(userId: string, id: string): Promise<ScheduledJob> {
    const row = await this.prisma.scheduledJob.findUnique({ where: { id } });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, '作业不存在');
    if (row.organizationId) await this.auth.require(userId, row.organizationId);
    else if (row.ownerUserId !== userId) throw new AppError(ErrorCode.NOT_FOUND, '作业不存在');
    return row;
  }

  // ===== 队列清理（事实源是行；清理只是减少无效投递） =====

  /** 移除该作业在队列中的延迟/等待 job（含重试 jobId 变体） */
  async removeQueuedJobs(id: string): Promise<void> {
    const exact = [oneShotJobId(id, 0), repeatJobId(id)];
    const prefix = retryJobIdPrefix(id);
    for (const list of [await this.queue.getDelayed(), await this.queue.getWaiting()]) {
      for (const job of list) {
        const jid = job.id ?? '';
        if (exact.includes(jid) || jid.startsWith(prefix)) {
          await job.remove().catch((err) => this.logger.warn({ jid }, `移除 job 失败: ${(err as Error).message}`));
        }
      }
    }
  }

  /** 注销 repeatable（按作业名匹配——BullMQ 不保留自定义 jobId 的 repeatable 元数据） */
  async removeRepeatable(id: string): Promise<void> {
    const jobs = await this.queue.getRepeatableJobs();
    for (const j of jobs) {
      if (j.name === repeatJobId(id) || j.id === repeatJobId(id)) await this.queue.removeRepeatableByKey(j.key);
    }
  }

  // ===== 校验 =====

  private validate(input: ScheduleJobInput): NormalizedSchedule {
    const name = (input.name ?? '').trim();
    if (!name || name.length > 120) throw new AppError(ErrorCode.VALIDATION_ERROR, '作业名称必填且不超过 120 字符');
    const handler = (input.handler ?? '').trim();
    if (!HANDLER_NAME.test(handler)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'handler 名称非法');
    const type: ScheduledJobType = input.type ?? (input.cron ? 'recurring' : 'one-shot');
    if (!['one-shot', 'delayed', 'recurring'].includes(type)) throw new AppError(ErrorCode.VALIDATION_ERROR, '作业类型非法');
    if (type === 'recurring') {
      const cron = (input.cron ?? '').trim();
      if (!isCronLike(cron)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'cron 表达式非法（需 5~6 段）');
      return {
        ...input, name, handler, type, cron,
        runAt: null,
        priority: input.priority ?? 0,
        timeoutMs: clamp(input.timeoutMs ?? 60_000, 1_000, 30 * 60_000),
        maxAttempts: clamp(input.maxAttempts ?? 3, 1, 20),
        backoffMs: clamp(input.backoffMs ?? 2_000, 0, 10 * 60_000),
      };
    }
    if (type === 'delayed' && input.runAt === undefined) throw new AppError(ErrorCode.VALIDATION_ERROR, 'delayed 作业必须提供 runAt');
    const runAt = input.runAt === undefined || input.runAt === null ? new Date() : new Date(input.runAt);
    if (Number.isNaN(runAt.getTime())) throw new AppError(ErrorCode.VALIDATION_ERROR, 'runAt 非法');
    return {
      ...input, name, handler, type, cron: null, runAt,
      priority: input.priority ?? 0,
      timeoutMs: clamp(input.timeoutMs ?? 60_000, 1_000, 30 * 60_000),
      maxAttempts: clamp(input.maxAttempts ?? 3, 1, 20),
      backoffMs: clamp(input.backoffMs ?? 2_000, 0, 10 * 60_000),
    };
  }
}

/**
 * BullMQ jobId 约定（**自定义 jobId 禁止含 ':'**——BullMQ 5 的 Job.validateOptions 硬性拒绝，
 * 故用 '-' 分隔；原始规格建议的 `sched:{id}` 形式在本版本不可用）：
 * - one-shot/delayed 首次投递：sched-{jobId}
 * - 失败重投（第 n 次）：sched-{jobId}-r{n}（当前 job 仍 active，必须换 id 才能重新入队）
 * - recurring：sched-rec-{jobId}（同时作为 BullMQ **作业名**——repeatable 元数据不保留自定义
 *   jobId，只有 name 能用于精确注销与去重）
 */
export const oneShotJobId = (id: string, attempt: number): string => (attempt > 0 ? `sched-${id}-r${attempt}` : `sched-${id}`);
export const repeatJobId = (id: string): string => `sched-rec-${id}`;
/** 重投变体前缀（清理时匹配 sched-{id}-r*） */
export const retryJobIdPrefix = (id: string): string => `sched-${id}-r`;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** cron 粗校验（5~6 段 + 字符集）——真实解析交给 BullMQ（非法表达式在入队时报错并回滚行） */
function isCronLike(cron: string): boolean {
  if (!cron || cron.length > 120) return false;
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return false;
  return parts.every((p) => CRON_FIELD.test(p));
}
