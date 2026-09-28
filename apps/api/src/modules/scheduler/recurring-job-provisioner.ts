import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { SchedulerService } from './scheduler.service';

/**
 * M11-P8（D2-18）：**平台周期作业开通器**——把"启动时开通一次、失败就永久告警"改成**周期性探测**。
 *
 * 背景（审计 D2-18）：`EventArchiveService.onModuleInit` 只尝试开通一次平台归档周期作业，失败
 * （DB 未就绪 / Redis 不可达 / 尚无 admin 用户）仅 `logger.warn` 一条，此后**进程整个生命周期内不再重试**
 * ——于是"自动归档"永久不生效，而唯一的人工兜底是运维手工建同 handler 的作业。同理，任何平台周期作业
 * （保留策略、归档）都面临这个"启动竞态"，而进程启动恰好是最容易 DB/Redis 未就绪的时刻。
 *
 * 语义（本类唯一职责：让平台周期作业**最终一定被开通**，且绝不越权改变运维意图）：
 * - **探测**（`probe`）：按幂等键直查 ScheduledJob 行（唯一索引，1 次查询）——
 *   · 行存在且活跃（scheduled/running）→ 什么都不做（**绝不重复入队、绝不改状态**）；
 *   · 行存在但非活跃（paused/dead/completed/cancelled）→ 只告警（状态**变化**时告警一次，
 *     避免巡检刷屏）——**绝不自动复活**：暂停/判死是运维显式动作或失败终态，自动复活会掩盖人工裁决；
 *   · 行缺失（从未开通 / 被硬删）→ 解析平台归属（最早的 admin）后按**既有 SchedulerService.schedule**
 *     开通（幂等键全局唯一 → 并发开通只有一个赢家，绝不产生第二个作业）。
 * - **重试**：未开通（无 admin / 开通抛错）时按指数退避重试（默认 30s → 封顶 15min，**永不放弃**：
 *   只告警不重试正是 D2-18 的缺陷本身）；已开通/人工停用时转入**慢巡检**（默认 15min），
 *   用于发现"作业行后来消失"的情形。
 * - **绝不阻塞启动**：`probe` 内部吞掉一切异常（只 warn），onModuleInit 路径上绝不抛错；
 *   `stop()`（OnModuleDestroy）清定时器，不拖住进程退出（定时器一律 `unref`）。
 *
 * 注：本类的"存在性直查"用的是**服务端常量幂等键**（`platform:*`），不是调用方输入——因此不存在
 * `SchedulerService.findIdempotent` 要防的"跨租户越权读"问题（那把 scoped 查询留给用户面 schedule 路径）。
 *
 * 节奏旋钮（env；生产默认值即上文数值）：`RECURRING_JOB_PROBE_MS`（慢巡检间隔）、
 * `RECURRING_JOB_RETRY_BASE_MS` / `RECURRING_JOB_RETRY_MAX_MS`（未开通时的退避）。
 */
export type ProvisionOutcome = 'active' | 'inactive' | 'retry' | 'stopped';

/** 活跃态（与 SchedulerService.SCHEDULED_ACTIVE_STATUSES 同源语义；本类只读观测，绝不写状态） */
const ACTIVE_STATUSES = ['scheduled', 'running'] as const;

/** 已开通后的慢巡检间隔（默认 15min；env RECURRING_JOB_PROBE_MS 覆盖——运维可调，e2e 用它把探测压到秒级） */
const DEFAULT_PROBE_MS = 15 * 60_000;
/** 未开通时的退避基数与上限（默认 30s → 15min；env RECURRING_JOB_RETRY_BASE_MS / _MAX_MS 覆盖） */
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_RETRY_MAX_MS = 15 * 60_000;

/** env 毫秒旋钮（非法/过小 → 默认；min 用于杜绝热循环） */
function envMs(name: string, fallback: number, min = 1_000): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.trunc(n) : fallback;
}

export interface RecurringJobSpec {
  name: string;
  /** 服务端注册表标识（绝不执行任意代码） */
  handler: string;
  cron: string;
  /** 幂等键（稳定且版本化：语义变更才换 v2，绝不无声换键产生第二个作业） */
  idempotencyKey: string;
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
  payload?: Record<string, unknown> | null;
  /** 作业存在但不在活跃态时的处置提示（拼进告警文案，例如"需运维显式 resume"） */
  inactiveHint: string;
}

export interface RecurringJobProvisionerInput {
  prisma: Pick<PrismaService, 'scheduledJob' | 'user'>;
  scheduler: Pick<SchedulerService, 'schedule'>;
  logger: Logger;
  spec: RecurringJobSpec;
  /** 已开通后的慢巡检间隔（ms） */
  probeMs?: number;
  /** 未开通时的退避基数（ms）与上限（ms） */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** 定时器注入（测试确定性）；默认 setTimeout/clearTimeout */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

export class RecurringJobProvisioner {
  private timer: NodeJS.Timeout | null = null;
  /** 连续失败次数（成功开通即归零）——退避用 */
  private retries = 0;
  private stopped = false;
  /** 上次观测到的作业身份/状态（仅在变化时告警，巡检不刷屏） */
  private observedJobId: string | null = null;
  private observedStatus: string | null = null;

  constructor(private readonly input: RecurringJobProvisionerInput) {}

  private get logger(): Logger { return this.input.logger; }
  private get spec(): RecurringJobSpec { return this.input.spec; }

  /** 是否仍有待执行的下一次探测（观测/测试用） */
  get pending(): boolean { return this.timer !== null; }

  /** 启动探测（onModuleInit 调用；绝不抛错） */
  async start(): Promise<ProvisionOutcome> {
    return this.probe();
  }

  /** 探测一次并安排下一次（绝不抛错）。返回本次结论（见 ProvisionOutcome） */
  async probe(): Promise<ProvisionOutcome> {
    if (this.stopped) return 'stopped';
    let outcome: ProvisionOutcome;
    try {
      outcome = await this.probeOnce();
    } catch (err) {
      // 兜底：probeOnce 内部已分路径处理，这里是最后一道（例如 logger 之外的意外）
      this.logger.warn(`周期作业探测异常（${this.spec.handler}）: ${message(err)}`);
      outcome = 'retry';
    }
    this.scheduleNext(outcome);
    return outcome;
  }

  /** 停机：清定时器，此后 probe 一律 no-op（幂等） */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.retries = 0;
  }

  // ===== 单次探测 =====

  private async probeOnce(): Promise<ProvisionOutcome> {
    const existing = await this.input.prisma.scheduledJob.findFirst({
      where: { idempotencyKey: this.spec.idempotencyKey },
      select: { id: true, status: true },
    });
    if (existing) return this.observe(existing.id, existing.status);

    // 行缺失 → 需要开通：平台作业必须有 owner（ScheduledJob.ownerUserId 必填外键）→ 最早的 admin 作平台身份
    const owner = await this.input.prisma.user.findFirst({
      where: { role: 'admin' }, orderBy: { createdAt: 'asc' }, select: { id: true },
    });
    if (!owner) {
      // 未初始化的库（seed 未跑）也会走到这里：**重试**而不是放弃——seed 完成后即可自动开通
      this.logger.warn(`无 admin 用户（未初始化？）→ 暂不开通周期作业 ${this.spec.handler}，稍后重试`);
      return 'retry';
    }

    let result: { job: { id: string; status: string }; created: boolean };
    try {
      result = await this.input.scheduler.schedule({
        ownerUserId: owner.id,
        organizationId: null,
        name: this.spec.name,
        handler: this.spec.handler,
        type: 'recurring',
        cron: this.spec.cron,
        timeoutMs: this.spec.timeoutMs,
        maxAttempts: this.spec.maxAttempts,
        backoffMs: this.spec.backoffMs,
        payload: this.spec.payload ?? null,
        idempotencyKey: this.spec.idempotencyKey,
      });
    } catch (err) {
      // DB/Redis 不可达等 → 退避重试（绝不"告警一次就永久停摆"）
      this.logger.warn(`周期作业开通失败（${this.spec.handler}；稍后按退避重试）: ${message(err)}`);
      return 'retry';
    }

    if (result.created) {
      this.retries = 0;
      this.observedJobId = result.job.id;
      this.observedStatus = result.job.status;
      this.logger.log(
        { jobId: result.job.id, cron: this.spec.cron, handler: this.spec.handler },
        '平台周期作业已开通',
      );
      return 'active';
    }
    // 幂等命中（并发赢家 / 本进程之外已开通）→ 按观测到的状态处置
    return this.observe(result.job.id, result.job.status);
  }

  /** 观测既有行的状态：活跃 → active；非活跃 → inactive（只告警，绝不自动复活） */
  private observe(jobId: string, status: string): ProvisionOutcome {
    const active = (ACTIVE_STATUSES as readonly string[]).includes(status);
    const changed = this.observedJobId !== jobId || this.observedStatus !== status;
    this.observedJobId = jobId;
    this.observedStatus = status;
    if (changed) {
      if (active) this.logger.log({ jobId, status }, '平台周期作业在活跃态');
      else this.logger.warn({ jobId, status }, `平台周期作业不在活跃态（${status}）→ 自动执行当前停用；${this.spec.inactiveHint}`);
    }
    if (active) this.retries = 0;
    return active ? 'active' : 'inactive';
  }

  // ===== 下一次探测 =====

  private scheduleNext(outcome: ProvisionOutcome): void {
    if (this.stopped) return;
    const delay = outcome === 'retry' ? this.nextRetryDelay() : this.probeMs();
    this.clearTimer();
    this.timer = (this.input.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
      this.timer = null;
      void this.probe();
    }, delay);
    this.timer.unref?.(); // 绝不因探测定时器拖住进程退出
  }

  /** 指数退避：base × 2^(n-1)，封顶 retryMaxMs（第 1 次失败后 base，第 2 次 2×base…） */
  private nextRetryDelay(): number {
    this.retries += 1;
    const base = this.input.retryBaseMs ?? envMs('RECURRING_JOB_RETRY_BASE_MS', DEFAULT_RETRY_BASE_MS);
    const max = this.input.retryMaxMs ?? envMs('RECURRING_JOB_RETRY_MAX_MS', DEFAULT_RETRY_MAX_MS);
    return Math.min(base * 2 ** (this.retries - 1), Math.max(base, max));
  }

  private probeMs(): number {
    return this.input.probeMs ?? envMs('RECURRING_JOB_PROBE_MS', DEFAULT_PROBE_MS);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    (this.input.clearTimer ?? clearTimeout)(this.timer);
    this.timer = null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}
