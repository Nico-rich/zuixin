import { Module } from '@nestjs/common';
import { EventPlatformModule } from './event-platform.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { EventsController } from './events.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫 */
@Module({
  imports: [EventPlatformModule, OrganizationsModule],
  controllers: [EventsController],
})
export class EventsApiModule {}
