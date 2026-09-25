import { Module } from '@nestjs/common';
import { SchedulerModule } from './scheduler.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SchedulerController } from './scheduler.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫 */
@Module({
  imports: [SchedulerModule, OrganizationsModule],
  controllers: [SchedulerController],
})
export class SchedulerApiModule {}
