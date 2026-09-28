import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SchedulerService } from '../scheduler/scheduler.service';

/**
 * M9-11 / M10-P10：EventEnvelope **归档消费者**（published → consumed）。
 *
 * 背景：Pre-M9 G10 冻结了事件平台——无消费者的事件类型其行永久停留在 `published`
 * （G10 明确记录为"预期现象，非缺陷"）；M9 审计（M9-11）指出：冻结可以，但**没有留存策略**
 * 意味着表随作业生命周期事件（每次调度作业完成/失败都落一行）无界增长。归档 = 给冻结的平台
 * 补上唯一缺失的收尾环节，**不引入任何新的平台结构**。
 *
 * 边界（与 G10 冻结条件一致，绝不越界）：
 * - **不新增消费者**：不走 `EventPlatformService.subscribe`/`deliver`（生产被冻结拒绝，
 *   且那会引入 per-consumer 投递语义）。归档只做**行状态收敛**：`published` → `consumed`；
 * - **不新增队列**：周期触发走既有 Scheduler（ScheduledJob 行 + repeatable job），
 *   与 workflow/media-cleanup 的既有周期任务并列，绝不新开 BullMQ 队列；
 * - **不改 EventEnvelope 结构 / 不删行**：事实源完整保留（schema 冻结），归档只是状态标记——
 *   已归档行仍可被 `list`（status=consumed）读到、`consumedAt` 可审计；**绝不物理删除**；
 * - **不碰 failed/dead**：那些状态意味着"消费失败待人工介入"（死信面），归档绝不掩盖未决状态。
 *
 * 语义契约：
 * - 保留窗口（默认 7 天，env `EVENT_ENVELOPE_RETENTION_MS`）显著大于任何消费者的处理延迟；
 *   冻结期无消费者，窗口的唯一作用是限制 `published` 存量（表增长有界）；
 * - **幂等**：条件更新（`status='published'` 参与 WHERE）——重复执行、并发执行（多 worker）、
 *   与真实消费者的 `deliver` 竞争，都只有唯一赢家；已 consumed 的行绝不二次处理；
 * - **批量**：每批 `limit=batchSize` 一次 SELECT + 一次 UPDATE（无长事务、无全表锁），
 *   批数上限 `maxBatches`（单次执行有界，未扫完的部分留给下一个周期——绝不长时间占用 worker）。
 */
export const DEFAULT_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_ARCHIVE_BATCH_SIZE = 500;
export const DEFAULT_ARCHIVE_MAX_BATCHES = 10;

/** handler 注册名（ScheduledJob.handler；安全底线：只执行服务端注册表里的名字） */
export const EVENT_ARCHIVE_HANDLER = 'events.archive';
/** 平台周期作业身份（幂等键稳定且**版本化**：语义变更才换 v2，绝不无声换键产生第二个作业） */
export const EVENT_ARCHIVE_IDEMPOTENCY_KEY = 'platform:event-envelope-archive:v1';
/** 周期：每 15 分钟一次（归档是收尾工作，不需要更密；每次执行有界，与保留窗口无关） */
export const EVENT_ARCHIVE_CRON = '*/15 * * * *';
export const EVENT_ARCHIVE_JOB_NAME = 'EventEnvelope 归档（published → consumed）';

export interface ArchiveRunOptions {
  /** 保留窗口覆盖（ms；仅测试/运维手工作业用——周期作业不写 payload，按 env 生效） */
  retentionMs?: number;
  batchSize?: number;
  maxBatches?: number;
  /** 注入"当前时间"（测试确定性；生产绝不用） */
  now?: Date;
}

export interface ArchiveRunResult {
  /** 候选行数（保守上界：已扫过的行，含被并发赢家抢先消费的行） */
  scanned: number;
  /** 本次真正归档（published → consumed）的行数 */
  archived: number;
  /** 实际执行的批次（0 = 无候选） */
  batches: number;
  /** 保留窗口（回显，便于日志/测试断言） */
  retentionMs: number;
}

/** 保留窗口解析（env EVENT_ENVELOPE_RETENTION_MS / eventEnvelopeRetentionMs；非法/非正 → 默认 7 天） */
export function eventRetentionMs(): number {
  const raw = process.env.EVENT_ENVELOPE_RETENTION_MS ?? process.env.eventEnvelopeRetentionMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_EVENT_RETENTION_MS;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

@Injectable()
export class EventArchiveService implements OnModuleInit {
  private readonly logger = new Logger('EventArchive');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
  ) {}

  /**
   * worker 启动：① 注册 handler（纯内存操作，必须成功——否则运维/测试创建的归档作业会被判"handler 未注册"）；
   * ② 尽力开通平台周期作业（best-effort：DB 未就绪/无 admin/Redis 不可达 → 只告警，**绝不让事件归档
   *   阻断进程启动**；周期作业缺失只影响"自动归档"，手工创建同 handler 的作业仍可执行）。
   *
   * 注：本服务由 EventPlatformModule 提供，而该模块同时被 SchedulerWorkerModule（worker 进程，
   * 归档的真实执行方）与 EventsApiModule（API 进程）导入——两个进程都会注册 handler 并尝试开通，
   * 开通受 idempotencyKey 全局唯一约束保护（并发 P2002 → 复用赢家行），绝不产生第二个作业。
   */
  async onModuleInit(): Promise<void> {
    this.scheduler.registerHandler(EVENT_ARCHIVE_HANDLER, (ctx) =>
      this.archiveExpired((ctx.payload ?? {}) as ArchiveRunOptions).then(() => undefined));
    try {
      await this.ensureRecurringJob();
    } catch (err) {
      this.logger.warn(
        `归档周期作业开通失败（不阻塞启动；可人工创建 handler=${EVENT_ARCHIVE_HANDLER} 的 recurring 作业）: ${(err as Error).message}`,
      );
    }
  }

  /**
   * 开通/确认平台周期作业（幂等）。归属：平台 admin（ScheduledJob.ownerUserId 是必填外键，
   * 平台作业必须有 owner——选最早的 admin 作为平台身份；**不为此改 schema**）。
   * 已被人工 pause/dead 的作业**绝不自动复活**（运维显式动作优先），只告警提示。
   */
  private async ensureRecurringJob(): Promise<void> {
    const owner = await this.prisma.user.findFirst({
      where: { role: 'admin' }, orderBy: { createdAt: 'asc' }, select: { id: true },
    });
    if (!owner) {
      this.logger.warn('无 admin 用户（未初始化？）→ 暂不开通归档周期作业');
      return;
    }
    const { job, created } = await this.scheduler.schedule({
      ownerUserId: owner.id,
      organizationId: null,
      name: EVENT_ARCHIVE_JOB_NAME,
      handler: EVENT_ARCHIVE_HANDLER,
      type: 'recurring',
      cron: EVENT_ARCHIVE_CRON,
      // 单次执行有界（10 批 × 500 行）；超过退避重投 3 次仍失败 → dead（运维面可见）
      timeoutMs: 120_000, maxAttempts: 3, backoffMs: 5_000,
      idempotencyKey: EVENT_ARCHIVE_IDEMPOTENCY_KEY,
    });
    if (created) {
      this.logger.log({ jobId: job.id, cron: EVENT_ARCHIVE_CRON, retentionMs: eventRetentionMs() }, '归档周期作业已开通');
      return;
    }
    if (job.status !== 'scheduled' && job.status !== 'running') {
      // paused/dead/completed/cancelled：运维意图或失败终态 —— 绝不静默复活，只提示
      this.logger.warn(
        { jobId: job.id, status: job.status },
        '归档周期作业不在活跃态（paused/dead/终态）→ 自动归档当前停用，需运维显式 resume',
      );
    }
  }

  /**
   * 归档：把 `occurredAt < now - retentionMs` 且仍为 `published` 的行标记为 `consumed`。
   * 返回本次实际归档数（幂等：无候选 → 0/0；重复执行 → 只对"还没被归档的行"生效）。
   */
  async archiveExpired(opts: ArchiveRunOptions = {}): Promise<ArchiveRunResult> {
    const retentionMs = clampInt(opts.retentionMs, eventRetentionMs(), 0, Number.MAX_SAFE_INTEGER);
    const batchSize = clampInt(opts.batchSize, DEFAULT_ARCHIVE_BATCH_SIZE, 1, 5_000);
    const maxBatches = clampInt(opts.maxBatches, DEFAULT_ARCHIVE_MAX_BATCHES, 1, 1_000);
    const cutoff = new Date((opts.now ?? new Date()).getTime() - retentionMs);
    const consumedAt = new Date();
    let scanned = 0;
    let archived = 0;
    let batches = 0;
    for (let i = 0; i < maxBatches; i++) {
      // 候选批：走 @@index([status, occurredAt])（索引前缀 status + 范围扫描 occurredAt），按最旧优先
      const rows = await this.prisma.eventEnvelope.findMany({
        where: { status: 'published', occurredAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { occurredAt: 'asc' },
        take: batchSize,
      });
      if (rows.length === 0) break;
      batches += 1;
      scanned += rows.length;
      const done = await this.prisma.eventEnvelope.updateMany({
        // 条件更新（published 参与 WHERE）：并发归档/真实消费者投递竞争下唯一赢家，绝不二次消费
        where: { id: { in: rows.map((r) => r.id) }, status: 'published' },
        data: { status: 'consumed', consumedAt, lastError: null },
      });
      archived += done.count;
      if (rows.length < batchSize) break; // 候选已扫尽（不满一批）→ 不多打一次空查询
    }
    if (archived > 0) {
      this.logger.log({ archived, scanned, batches, cutoff, retentionMs }, 'EventEnvelope 归档完成（published → consumed）');
    }
    return { scanned, archived, batches, retentionMs };
  }
}
