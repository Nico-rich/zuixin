import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ObservabilityService, RETENTION_METRIC_NAMES } from '../../core/tracing/observability.service';
import { SchedulerService } from './scheduler.service';
import { RecurringJobProvisioner } from './recurring-job-provisioner';

/**
 * M11-P8（D1-07）：**MetricSample 保留策略**——把 M8-P3 起"只增不减"的观测表补上唯一缺失的收尾环节。
 *
 * 背景：`MetricSample` 是 HTTP 中间件按请求采样（request_count/request_latency_ms/error_count）、
 * 队列深度、run 时长、provider 降级等的落地表，**没有任何保留策略**（M10 已登记 Deferred）——
 * 表随请求量无界增长（每请求 2~3 行），最终拖垮写入与查询。本服务只做**删除面**决策：
 * 周期删除 `sampledAt < now - METRIC_RETENTION_DAYS 天` 的样本，其余一律不动（不改表结构、不加队列、
 * 不动采样/读取路径——采样仍是 best-effort 的 `ObservabilityService.recordMetric`）。
 *
 * 边界与安全：
 * - **周期触发走既有 Scheduler**（ScheduledJob 行 + repeatable job），绝不新开 BullMQ 队列；
 * - **批量 + 有界**：单次执行有界（`maxBatches` 批次预算），未删完的留给下一个周期，绝不长时间占用 worker；
 * - **幂等 + 条件删除**：`deleteMany` 的 WHERE 同时含 `sampledAt < cutoff`（并发/重复执行下唯一赢家，
 *   绝不越界删窗口内的行）；重复执行不产生额外副作用；
 * - **索引友好**（无 schema 变更的前提下）：`sampledAt` 不是任何既有索引的前导列
 *   （`@@index([name, sampledAt])` / `@@index([organizationId, sampledAt])`），直接按 `sampledAt` 过滤
 *   只能全表扫描。故按**指标名轮转**：每批 `WHERE name = ? AND sampledAt < cutoff ORDER BY sampledAt`
 *   正好命中 `[name, sampledAt]` 复合索引（过滤 + 排序都由索引满足，无 sort、无 seq scan）。
 *   指标名清单由 `groupBy(name)` 现场枚举（index-only 扫描）——**绝不硬编码名单**，新指标自动纳入；
 * - **保留天数是运维契约**：env `METRIC_RETENTION_DAYS`（默认 30）；非法/非正回落默认（0/负数绝不静默
 *   变成"删光"或"不删"）；手工作业可用 payload 覆盖（周期作业不写 payload → 按 env 生效）；
 * - **观测**：每次执行记一条 `metric_sample_purge_count`（value = 本次删除行数，含 0——0 是活性信号），
 *   批次预算用尽时额外告警（说明删除速度已追不上采样速度，需要调大预算或提高频率）。
 */
export const METRIC_RETENTION_HANDLER = 'metrics.retention';
/** 平台周期作业身份（幂等键稳定且**版本化**：语义变更才换 v2，绝不无声换键产生第二个作业） */
export const METRIC_RETENTION_IDEMPOTENCY_KEY = 'platform:metric-sample-retention:v1';
/** 周期：每日 03:23（UTC）——避开整点与 UTC 日界（聚合/对账任务密集时段），保留策略是收尾工作 */
export const METRIC_RETENTION_CRON = '23 3 * * *';
export const METRIC_RETENTION_JOB_NAME = 'MetricSample 保留策略（超期样本删除）';
/** 保留天数默认值（env METRIC_RETENTION_DAYS 覆盖） */
export const DEFAULT_METRIC_RETENTION_DAYS = 30;
/** 单批删除行数（findMany take；一次 SELECT + 一次 DELETE，无长事务） */
export const DEFAULT_METRIC_PURGE_BATCH_SIZE = 1_000;
/** 单次执行的批次预算（跨指标名轮转共享）：1000 × 500 = 单次上限 50 万行 */
export const DEFAULT_METRIC_PURGE_MAX_BATCHES = 500;

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface PurgeRunOptions {
  /** 保留天数覆盖（仅测试/运维手工作业用——周期作业不写 payload，按 env 生效） */
  retentionDays?: number;
  batchSize?: number;
  /** 单次执行的批次预算（跨指标名轮转共享） */
  maxBatches?: number;
  /** 注入"当前时间"（测试确定性；生产绝不用） */
  now?: Date;
}

export interface PurgeRunResult {
  /** 本次真正删除的行数 */
  deleted: number;
  /** 候选行数（保守上界：含被并发/竞态抢先删除的行） */
  scanned: number;
  /** 实际执行的批次（0 = 无候选） */
  batches: number;
  /** 参与轮转的指标名数（0 = 表内无样本） */
  names: number;
  /** 批次预算用尽（仍有超期样本未删完；下个周期继续） */
  truncated: boolean;
  /** 生效的保留天数（回显，便于日志/测试断言） */
  retentionDays: number;
  /** 截止时刻（严格早于它的样本才会被删） */
  cutoff: Date;
}

/** 保留天数解析（env METRIC_RETENTION_DAYS / metricRetentionDays；非法/非正 → 默认 30 天） */
export function metricRetentionDays(): number {
  const raw = process.env.METRIC_RETENTION_DAYS ?? process.env.metricRetentionDays;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_METRIC_RETENTION_DAYS;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

@Injectable()
export class MetricRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MetricRetention');
  private readonly provisioner: RecurringJobProvisioner;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(ObservabilityService) private readonly metrics: ObservabilityService,
  ) {
    this.provisioner = new RecurringJobProvisioner({
      prisma,
      scheduler,
      logger: this.logger,
      spec: {
        name: METRIC_RETENTION_JOB_NAME,
        handler: METRIC_RETENTION_HANDLER,
        cron: METRIC_RETENTION_CRON,
        idempotencyKey: METRIC_RETENTION_IDEMPOTENCY_KEY,
        // 单次执行有界（500 批 × 1000 行）；超过退避重投 3 次仍失败 → dead（运维面可见）
        timeoutMs: 600_000, maxAttempts: 3, backoffMs: 5_000,
        inactiveHint: '自动保留策略当前停用，需运维显式 resume',
      },
    });
  }

  /**
   * 启动：① 注册 handler（纯内存操作，必须成功——否则运维/测试创建的保留作业会被判"handler 未注册"）；
   * ② 开通平台周期作业（周期性探测，失败自动退避重试——见 RecurringJobProvisioner；绝不阻塞启动）。
   *
   * 注：本服务由 SchedulerModule 提供，而该模块被 API 进程（SchedulerApiModule / EventPlatformModule）
   * 与 Worker 进程（SchedulerWorkerModule）共同导入——真实执行方是 worker；两进程都会注册 handler 并探测开通，
   * 开通受 idempotencyKey 全局唯一约束保护（并发 → 复用赢家行），绝不产生第二个作业。
   */
  async onModuleInit(): Promise<void> {
    this.scheduler.registerHandler(METRIC_RETENTION_HANDLER, (ctx) =>
      this.purgeExpired((ctx.payload ?? {}) as PurgeRunOptions).then(() => undefined));
    await this.provisioner.start();
  }

  onModuleDestroy(): void {
    this.provisioner.stop();
  }

  /**
   * 删除超期样本（`sampledAt < now - retentionDays`）。**幂等**：无候选 → 0 副作用；重复执行只对
   * "还没被删的行"生效。按指标名轮转 + 每名限量批，单次执行有界（批次预算）。
   */
  async purgeExpired(opts: PurgeRunOptions = {}): Promise<PurgeRunResult> {
    const retentionDays = clampInt(opts.retentionDays, metricRetentionDays(), 1, 3_650);
    const batchSize = clampInt(opts.batchSize, DEFAULT_METRIC_PURGE_BATCH_SIZE, 1, 10_000);
    const maxBatches = clampInt(opts.maxBatches, DEFAULT_METRIC_PURGE_MAX_BATCHES, 1, 10_000);
    const cutoff = new Date((opts.now ?? new Date()).getTime() - retentionDays * DAY_MS);

    // 指标名现场枚举（GROUP BY name：走 [name, sampledAt] 的 index-only 扫描）——绝不硬编码名单
    const groups = await this.prisma.metricSample.groupBy({ by: ['name'] });
    const names = groups.map((g) => g.name);

    let deleted = 0;
    let scanned = 0;
    let batches = 0;
    let budgetExhausted = false;
    if (names.length > 0) {
      // 轮转：每轮每名各删一批（大指标名不会饿死其它名；单名候选 > 预算时下个周期继续）
      for (;;) {
        let progressed = false;
        for (const name of names) {
          if (batches >= maxBatches) { budgetExhausted = true; break; }
          const rows = await this.prisma.metricSample.findMany({
            where: { name, sampledAt: { lt: cutoff } }, // 命中 [name, sampledAt]：等值前缀 + 范围
            select: { id: true },
            orderBy: { sampledAt: 'asc' }, // 索引同时满足排序 → 不产生 sort（最旧优先删）
            take: batchSize,
          });
          if (rows.length === 0) continue;
          progressed = true;
          batches += 1;
          scanned += rows.length;
          const done = await this.prisma.metricSample.deleteMany({
            // 条件删除（sampledAt 参与 WHERE）：重复/并发执行只有唯一赢家，绝不越界删窗口内的行
            where: { id: { in: rows.map((r) => r.id) }, sampledAt: { lt: cutoff } },
          });
          deleted += done.count;
        }
        if (budgetExhausted || !progressed) break;
      }
    }
    // 预算用尽 ≠ 一定还有活儿（可能恰好删完）：再查一次确认（1 次 LIMIT 1 索引查询），避免假警报
    const truncated = budgetExhausted ? await this.hasExpired(names, cutoff) : false;

    if (deleted > 0) {
      this.logger.log(
        { deleted, scanned, batches, names: names.length, cutoff, retentionDays },
        'MetricSample 保留策略执行完成（超期样本已删除）',
      );
    } else {
      // M11-P8：0 行也留痕（debug）——"任务在跑但没活儿"与"任务没跑"必须可区分
      this.logger.debug({ scanned, batches, cutoff, retentionDays }, 'MetricSample 保留策略执行完成：无超期样本');
    }
    if (truncated) {
      this.logger.warn(
        { deleted, batches, maxBatches, retentionDays },
        'MetricSample 保留策略批次预算用尽：仍有超期样本未删完（删除速度已追不上采样速度 → 调大预算/提高执行频率）',
      );
    }

    // 保留策略活性指标（value = 删除行数，含 0；平台级事实 → organizationId 显式 null；无敏感字段）
    await this.metrics.recordMetric(RETENTION_METRIC_NAMES.metricSamplePurgeCount, deleted, 'count', {
      retentionDays, batches, names: names.length, truncated,
    }, null);

    return { deleted, scanned, batches, names: names.length, truncated, retentionDays, cutoff };
  }

  /** 是否仍有超期样本（批次预算用尽后的确认查询；LIMIT 1，多名走 bitmap OR，代价可忽略） */
  private async hasExpired(names: string[], cutoff: Date): Promise<boolean> {
    if (names.length === 0) return false;
    const row = await this.prisma.metricSample.findFirst({
      where: { name: { in: names }, sampledAt: { lt: cutoff } },
      select: { id: true },
    });
    return row !== null;
  }
}
