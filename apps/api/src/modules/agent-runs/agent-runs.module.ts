import { Module } from '@nestjs/common';
import { AgentRunsService } from './agent-runs.service';
import { AgentRunTimelineService } from './agent-run-timeline.service';
import { AgentRunMessagesService } from './agent-run-messages.service';
import { AgentRunsController } from './agent-runs.controller';

@Module({
  controllers: [AgentRunsController],
  providers: [AgentRunsService, AgentRunTimelineService, AgentRunMessagesService],
  exports: [AgentRunsService, AgentRunTimelineService, AgentRunMessagesService],
})
export class AgentRunsModule {}
