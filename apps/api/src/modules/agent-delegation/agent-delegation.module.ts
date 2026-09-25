import { Module } from '@nestjs/common';
import { QueueModule } from '../../core/queue/queue.module';
import { DelegationService } from './delegation.service';

/** M7-P7 服务层（API 与 Worker 共用——工具在 Worker 进程执行） */
@Module({
  imports: [QueueModule],
  providers: [DelegationService],
  exports: [DelegationService],
})
export class AgentDelegationModule {}
