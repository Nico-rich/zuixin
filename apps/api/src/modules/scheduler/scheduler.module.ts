import { Module } from '@nestjs/common';
import { SchedulerQueueModule } from '../../core/queue/scheduler-queue.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SchedulerService } from './scheduler.service';

/** M8-P5 服务层（API 与 Worker 共用；HTTP 面在 SchedulerApiModule——Worker 不引入 JWT 守卫） */
@Module({
  imports: [SchedulerQueueModule, OrganizationsModule],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
