import { Module } from '@nestjs/common';
import { EventsModule } from '../../core/events/events.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { EventPlatformService } from './event-platform.service';

/**
 * M8-P5 Event Platform 服务层（API 与 Worker 共用；HTTP 面在 EventsApiModule）。
 * 依赖 core/events 的 EventBusService 仅作实时通知通道——事实永远是 EventEnvelope 行。
 */
@Module({
  imports: [EventsModule, OrganizationsModule],
  providers: [EventPlatformService],
  exports: [EventPlatformService],
})
export class EventPlatformModule {}
