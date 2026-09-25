import { Module } from '@nestjs/common';
import { AgentRunsService } from './agent-runs.service';
import { AgentRunTimelineService } from './agent-run-timeline.service';
import { AgentRunMessagesService } from './agent-run-messages.service';
import { QueueModule } from '../../core/queue/queue.module';
import { AgentDelegationModule } from '../agent-delegation/agent-delegation.module';

/** 服务层（API 与 Worker 共用；HTTP 面在 AgentRunsApiModule——Worker 不引入 JWT 守卫） */
@Module({
  imports: [QueueModule, AgentDelegationModule],
  providers: [AgentRunsService, AgentRunTimelineService, AgentRunMessagesService],
  exports: [AgentRunsService, AgentRunTimelineService, AgentRunMessagesService],
})
export class AgentRunsModule {}
