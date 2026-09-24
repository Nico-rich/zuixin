import { Module } from '@nestjs/common';
import { AgentRunLeaseService } from './agent-run-lease.service';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [QueueModule],
  providers: [AgentRunLeaseService],
  exports: [AgentRunLeaseService],
})
export class AgentRunLeaseModule {}
