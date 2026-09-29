import { Module } from '@nestjs/common';
import { SchedulerQueueModule } from '../../core/queue/scheduler-queue.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { SchedulerService } from './scheduler.service';
import { MetricRetentionService } from './metric-retention.service';
import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { StorageOrphanSweepService } from './storage-orphan-sweep.service';

/**
 * M8-P5 服务层（API 与 Worker 共用；HTTP 面在 SchedulerApiModule——Worker 不引入 JWT 守卫）。
 *
 * M11-P8：本模块同时承载**平台保留策略周期任务**（`MetricRetentionService`，D1-07）——
 * 它是 SchedulerModule 的 provider（而非独立模块），因为 SchedulerModule 是 API 与 Worker 两个进程图
 * 共同导入的既有模块：worker 侧（SchedulerWorkerModule import 本模块）由此自动注册 `metrics.retention`
 * handler 并成为真实执行方，绝不新开队列、也不改 worker 侧任何文件。
 *
 * M12-P5：同一范式再挂两个平台周期任务（都不新开队列、都不改 worker 侧文件）：
 * - `AnalyticsAggregationService`（analytics.aggregation）：分析聚合 cron 化——无读请求的组织也有聚合行，
 *   昨日在当日被重算（跨零点补齐），显式刷新仍是历史兜底；
 * - `StorageOrphanSweepService`（storage.orphan-sweep）：孤儿存储对象清扫——依赖驱动可选 `list` 能力，
 *   **默认干跑**（`STORAGE_ORPHAN_SWEEP_APPLY=true` 或 job payload `{apply:true}` 才真删），
 *   且只删"超龄（默认 7 天）+ DB 三张引用表都查不到 + 非保护前缀"的对象。
 */
@Module({
  imports: [SchedulerQueueModule, OrganizationsModule, AnalyticsModule],
  providers: [SchedulerService, MetricRetentionService, AnalyticsAggregationService, StorageOrphanSweepService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
