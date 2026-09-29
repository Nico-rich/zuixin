import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ObservabilityService } from '../../core/tracing/observability.service';
import { AnalyticsService, RefreshOrganizationsOptions } from '../analytics/analytics.service';
import { SchedulerService } from './scheduler.service';
import { RecurringJobProvisioner } from './recurring-job-provisioner';

/**
 * M12-P5：**Analytics 周期聚合**（M12 审计项："Analytics 没有 cron 聚合"）。
 *
 * 背景：M8-P4 的分析聚合是**读时补偿**语义（读路径只补刷当日，历史日期只由显式
 * `POST /analytics/refresh` 维护）。于是：
 * ① 没有任何读请求的组织**从不产生聚合行**（数据面空白）；
 * ② 当日行在 23:5x 之后不再被写，永远缺最后几分钟（且没有任何机制在次日把它补全）。
 * 本服务把刷新接上**既有 Scheduler**（ScheduledJob 行 + repeatable job），不新开队列、不改读路径。
 *
 * 分工（三条刷新路径互不重叠、语义各自清晰）：
 * - **读路径**（overview/breakdown）：只补刷当日——实时性由它保证（原样保留，一行未改）；
 * - **本周期任务**：窗口 [今日-1, 今日]（可配），**组织轮转**——无读请求的组织也持续有聚合行，
 *   且昨日在这一整天内被重算（跨零点/迟到事实修复），下一个 UTC 日界后不再触碰（此后冻结）；
 * - **显式刷新**（POST /analytics/refresh）：人工兜底，可回填任意历史区间（≤366 天）。
 *
 * 幂等与有界：全部由 `AnalyticsService.refreshStaleOrganizations` 保证（组织预算 + 页预算 +
 * 失败隔离 + 幂等 upsert）；本服务只负责"周期触发 + 观测"，不重复实现聚合逻辑。
 *
 * 注：本服务是 SchedulerModule 的 provider（而非独立模块）——SchedulerModule 是 API 与 Worker 两进程
 * 共同导入的既有模块，worker 侧由此自动注册 handler 并成为真实执行方（与 MetricRetentionService 同一范式）。
 */
export const ANALYTICS_AGGREGATION_HANDLER = 'analytics.aggregation';
/** 平台周期作业身份（幂等键稳定且**版本化**：语义变更才换 v2） */
export const ANALYTICS_AGGREGATION_IDEMPOTENCY_KEY = 'platform:analytics-aggregation:v1';
/**
 * 周期：每 5 分钟（UTC，5 字段 cron：分钟位为"步进 5"，见下方常量）。
 * 选 5 分钟的理由：单轮有界（默认 ≤50 组织 × ≤2 天），代价恒定且小；频率够高，当日数字与读路径
 * 的实时结果不会出现肉眼可见的分歧；又足够稀疏，不会与短周期业务任务抢 worker。
 *
 * 注意：本注释里**不要**写出 cron 全文——`星号 + 斜杠` 序列会在块注释里提前闭合（TS1109）。
 */
export const ANALYTICS_AGGREGATION_CRON = '*/5 * * * *';
export const ANALYTICS_AGGREGATION_JOB_NAME = 'Analytics 周期聚合（今日+昨日，组织轮转）';

@Injectable()
export class AnalyticsAggregationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AnalyticsAggregation');
  private readonly provisioner: RecurringJobProvisioner;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(ObservabilityService) private readonly metrics: ObservabilityService,
  ) {
    this.provisioner = new RecurringJobProvisioner({
      prisma,
      scheduler,
      logger: this.logger,
      spec: {
        name: ANALYTICS_AGGREGATION_JOB_NAME,
        handler: ANALYTICS_AGGREGATION_HANDLER,
        cron: ANALYTICS_AGGREGATION_CRON,
        idempotencyKey: ANALYTICS_AGGREGATION_IDEMPOTENCY_KEY,
        // 单轮有界（≤50 组织 × 2 天 × ~17 查询）；失败退避重投 3 次仍失败 → dead（运维面可见）
        timeoutMs: 300_000, maxAttempts: 3, backoffMs: 5_000,
        inactiveHint: 'Analytics 周期聚合当前停用，需运维显式 resume',
      },
    });
  }

  /**
   * 启动：① 注册 handler（纯内存，必须成功——否则运维/测试建的同 handler 作业会被判"未注册"）；
   * ② 开通平台周期作业（周期探测 + 退避重试，绝不阻塞启动）。真实执行方是 worker。
   */
  async onModuleInit(): Promise<void> {
    this.scheduler.registerHandler(ANALYTICS_AGGREGATION_HANDLER, (ctx) =>
      this.run((ctx.payload ?? {}) as RefreshOrganizationsOptions).then(() => undefined));
    await this.provisioner.start();
  }

  onModuleDestroy(): void {
    this.provisioner.stop();
  }

  /** 单轮聚合（幂等）：委托 AnalyticsService 的有界轮转刷新，并记一条活性指标。 */
  async run(opts: RefreshOrganizationsOptions = {}) {
    const result = await this.analytics.refreshStaleOrganizations(opts);
    // 活性指标：value = 本轮成功刷新的 (org, period) 组合数（0 也是信号）；平台级事实 → organizationId 显式 null
    await this.metrics.recordMetric('analytics_aggregation_refreshed', result.refreshed, 'count', {
      organizations: result.organizations, periods: result.periods, failed: result.failed,
      truncated: result.truncated, from: result.from, to: result.to,
    }, null);
    if (result.failed > 0) {
      this.logger.warn(
        { organizations: result.organizations, failed: result.failed, from: result.from, to: result.to },
        'Analytics 周期聚合部分失败（失败组织下轮重试；本轮其余组织已刷新）',
      );
    }
    return result;
  }
}
