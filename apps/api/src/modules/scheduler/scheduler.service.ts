import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import type { ScheduledJob } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../organizations/authorization.service';
import { SCHEDULER_QUEUE } from '../../core/queue/scheduler-queue.module';
import { addJobBounded } from '../../core/queue/bounded-add';
import { AppError, ErrorCode } from '../../common/errors/app-error';

export type ScheduledJobType = 'one-shot' | 'delayed' | 'recurring';
/** 可执行状态（处理器只从这两个状态认领——终态/暂停/取消的行绝不被 BullMQ 残留 job 意外执行） */
export const SCHEDULED_ACTIVE_STATUSES = ['pending', 'scheduled'] as const;

/**
 * Pre-M9 G9：`ScheduledJob.status` 语义（**沿用既有取值，不新增**；schema 列注释为准）：
 * - `pending` / `scheduled`：可执行（待投递 / 已投递且等 BullMQ 触发）；
 * - `running`：处理器已认领并执行中（心跳经 updatedAt 观测）；
 * - `paused`：用户暂停（行保留、队列投递已移除）→ resume 重建投递；
 * - `dead`：**终态失败**（重试超 maxAttempts，或 stalled 心跳中断被判死）→ 人工显式 resume 可复活；
 * - `completed` / `cancelled`：终态，任何路径都不复活（resume/cancel 都拒绝对它们操作）。
 * `failed` 为 schema 注释中的历史取值，当前实现不写入（终态失败统一为 `dead`）。
 */
export const SCHEDULED_RESUMABLE_STATUSES = ['paused', 'dead'] as const;

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
   * 创建调度作业（幂等：**同 scope（organizationId + ownerUserId）**同 idempotencyKey → 返回已有行，**不重复入队**）。
   * 幂等命中不重新投递是刻意选择：已有活跃行可能正处在重投（jobId 变体）中，
   * 再补一条首次投递会产生第二次执行——宁可让调用方显式走 resume/cancel 重建。
   *
   * 幂等键是**全局唯一**约束（schema 不可改）：若只按键查行，任何登录用户猜到/复用他人的键
   * 就能拿到他人的作业行（含 payload）并收到 created:false —— 跨租户越权读 + 事实上的键抢占。
   * 因此命中查询一律限定在调用方 scope 内；scope 外撞键（含并发 P2002）→ 404 反枚举。
   */
  async schedule(input: ScheduleJobInput): Promise<{ job: ScheduledJob; created: boolean }> {
    const normalized = this.validate(input);

    if (normalized.idempotencyKey) {
      const existing = await this.findIdempotent(normalized);
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
      // 并发同键 → P2002：先按 scope 复取赢家行（幂等语义；绝不第二个作业）；
      // scope 内查不到 = 该键属于别的组织/用户 → 404 反枚举（绝不返回、绝不泄漏对方行任何字段）
      if ((err as { code?: string }).code === 'P2002' && normalized.idempotencyKey) {
        const won = await this.findIdempotent(normalized);
        if (won) return { job: won, created: false };
        throw new AppError(ErrorCode.NOT_FOUND, '作业不存在');
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

  /**
   * 幂等键命中查询（**必须限定调用方 scope**）：ScheduledJob.idempotencyKey 是全局唯一索引，
   * 只按键查 = 跨租户越权读（返回他人行含 payload/name/handler/traceId）。故按
   * (idempotencyKey, organizationId, ownerUserId) 三元组在 scope 内查找；查不到即视为
   * "该键不属于调用方"（调用方转 404，绝不区分"键不存在"与"键属于别人"）。
   */
  private findIdempotent(n: NormalizedSchedule): Promise<ScheduledJob | null> {
    // 无键 = 无幂等语义：直接视为"无命中"（绝不退化成按 idempotencyKey: null 的全表匹配）
    if (!n.idempotencyKey) return Promise.resolve(null);
    return this.prisma.scheduledJob.findFirst({
      where: {
        idempotencyKey: n.idempotencyKey,
        organizationId: n.organizationId ?? null,
        ownerUserId: n.ownerUserId,
      },
    });
  }

  /** 投递到 BullMQ：one-shot/delayed → delayed job；recurring → repeatable job */
  private async enqueue(row: ScheduledJob, delayOverrideMs?: number): Promise<void> {
    if (row.type === 'recurring') {
      if (!row.cron) throw new AppError(ErrorCode.VALIDATION_ERROR, 'recurring 作业缺少 cron');
      // 作业名 = 行身份（BullMQ 的 repeatable 元数据不保留自定义 jobId，只有 name 可用于精确注销）；
      // 同名同 pattern 重复注册由 BullMQ 去重（pause→resume 重建不会产生第二条）
      await addJobBounded(this.queue,
        repeatJobId(row.id),
        { jobId: row.id },
        { jobId: repeatJobId(row.id), repeat: { pattern: row.cron }, removeOnComplete: true, removeOnFail: true, priority: row.priority },
        `recurring:${row.id}`);
      return;
    }
    const delay = delayOverrideMs ?? Math.max(0, (row.runAt?.getTime() ?? Date.now()) - Date.now());
    await addJobBounded(this.queue,
      'scheduled-job',
      { jobId: row.id },
      { jobId: oneShotJobId(row.id, row.attempts), delay, removeOnComplete: true, removeOnFail: true, priority: row.priority },
      `one-shot:${row.id}`);
  }

  /**
   * 失败重投（worker 退避用）：jobId 用新变体 `sched-{id}-r{attempt}`——当前 job 仍处于 active，
   * 同 id add 会被 BullMQ 判重丢弃（作业就永远卡住）。
   */
  async enqueueRetry(id: string, delayMs: number, attempt: number): Promise<void> {
    // Pre-M9 G4：投递有界（2s）——调用方（worker 失败重投路径）已有 catch 告警，行仍为 scheduled 可人工触发
    await addJobBounded(this.queue,
      'scheduled-job',
      { jobId: id },
      { jobId: oneShotJobId(id, attempt), delay: Math.max(0, Math.trunc(delayMs)), removeOnComplete: true, removeOnFail: true },
      `retry:${id}#${attempt}`);
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

  /**
   * 恢复（paused/dead → scheduled + 重建 BullMQ job；attempts 归零、lastError/completedAt 清空）。
   *
   * Pre-M9 G9：**dead 也可 resume**——死信作业此前无任何显式复活路径（stalled 巡检与重试超限都判 dead，
   * 而 resume 只认 paused），运维只能改库。dead 是"需要人工裁决"而非"永久不可用"：
   * 人工修好下游后 resume 即可重新投递（attempts 归零 → 重试预算重置）。
   * 其余状态（completed/cancelled/running/pending/scheduled）→ 400：终态不复活。
   */
  async resume(userId: string, id: string): Promise<{ resumed: boolean; status: string }> {
    const row = await this.get(userId, id);
    const done = await this.prisma.scheduledJob.updateMany({
      where: { id, status: { in: [...SCHEDULED_RESUMABLE_STATUSES] } },
      data: { status: 'scheduled', attempts: 0, lastError: null, completedAt: null },
    });
    if (done.count === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `作业不在可恢复状态（当前 ${row.status}；可恢复：paused/dead）`);
    }
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

  /**
   * 单行读取 + 归属校验（组织作业 → membership；个人作业 → owner 本人）。
   *
   * M10-P15 结论（**回滚曾经的"一律 404"改动**）：组织作业的归属裁决走 `auth.require` —— 非成员
   * 一律 403（禁用组织 403 `ORG_DISABLED`），这是 **M8-P5 冻结的错误码语义**
   * （`m8-p5-scheduler-events.e2e-spec.ts`「B 对 A 的作业做写操作 → 403（非成员）」），
   * 不得为了消除"作业行存在性 oracle"而改动它（冻结原则优先；该 1 位 oracle 已列入 P15 报告风险清单）。
   * 个人作业（organizationId=null）仍按 `ownerUserId` 判等 → 跨用户 404（防枚举，与 workflows/connections 同口径）。
   */
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
