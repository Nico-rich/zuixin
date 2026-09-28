import { Module } from '@nestjs/common';
import { EventsModule } from '../../core/events/events.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { EventPlatformService } from './event-platform.service';
import { EventArchiveService } from './event-archive.service';

/**
 * M8-P5 Event Platform 服务层（API 与 Worker 共用；HTTP 面在 EventsApiModule）。
 * 依赖 core/events 的 EventBusService 仅作实时通知通道——事实永远是 EventEnvelope 行。
 *
 * Pre-M9 G10：**FROZEN（冻结，方案 B）**。保留表结构与幂等写入 API（publish）；
 * 生产不得再注册消费者（`EventPlatformService.subscribe` 在生产进程直接拒绝），
 * 不得新增 relay/outbox 中继或为投递新增 job —— 若发现真实消费者需求，先报 Coordinator。
 * 冻结依据与范围见 `event-platform.service.ts` 顶部注释（EVENT_PLATFORM_FROZEN）。
 *
 * M9-11 / M10-P10：**唯一豁免 = 归档消费者**（`EventArchiveService`，Coordinator 在 M10-P10 立项）。
 * 它不是 relay/消费者：不加订阅、不建队列、不改表结构，只把超过保留窗口的 `published` 行
 * 条件收敛为 `consumed`（周期触发复用既有 Scheduler——`SchedulerModule` 由此导入；
 * 本模块被 SchedulerWorkerModule 导入 → worker 进程即归档的执行方）。
 */
@Module({
  imports: [EventsModule, OrganizationsModule, SchedulerModule],
  providers: [EventPlatformService, EventArchiveService],
  exports: [EventPlatformService, EventArchiveService],
})
export class EventPlatformModule {}
