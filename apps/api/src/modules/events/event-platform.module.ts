import { Module } from '@nestjs/common';
import { EventsModule } from '../../core/events/events.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { EventPlatformService } from './event-platform.service';

/**
 * M8-P5 Event Platform 服务层（API 与 Worker 共用；HTTP 面在 EventsApiModule）。
 * 依赖 core/events 的 EventBusService 仅作实时通知通道——事实永远是 EventEnvelope 行。
 *
 * Pre-M9 G10：**FROZEN（冻结，方案 B）**。保留表结构与幂等写入 API（publish）；
 * 生产不得再注册消费者（`EventPlatformService.subscribe` 在生产进程直接拒绝），
 * 不得新增 relay/outbox 中继或为投递新增 job —— 若发现真实消费者需求，先报 Coordinator。
 * 冻结依据与范围见 `event-platform.service.ts` 顶部注释（EVENT_PLATFORM_FROZEN）。
 */
@Module({
  imports: [EventsModule, OrganizationsModule],
  providers: [EventPlatformService],
  exports: [EventPlatformService],
})
export class EventPlatformModule {}
