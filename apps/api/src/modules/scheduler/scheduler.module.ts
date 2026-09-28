import { Module } from '@nestjs/common';
import { SchedulerQueueModule } from '../../core/queue/scheduler-queue.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SchedulerService } from './scheduler.service';
import { MetricRetentionService } from './metric-retention.service';

/**
 * M8-P5 服务层（API 与 Worker 共用；HTTP 面在 SchedulerApiModule——Worker 不引入 JWT 守卫）。
 *
 * M11-P8：本模块同时承载**平台保留策略周期任务**（`MetricRetentionService`，D1-07）——
 * 它是 SchedulerModule 的 provider（而非独立模块），因为 SchedulerModule 是 API 与 Worker 两个进程图
 * 共同导入的既有模块：worker 侧（SchedulerWorkerModule import 本模块）由此自动注册 `metrics.retention`
 * handler 并成为真实执行方，绝不新开队列、也不改 worker 侧任何文件。
 */
@Module({
  imports: [SchedulerQueueModule, OrganizationsModule],
  providers: [SchedulerService, MetricRetentionService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
