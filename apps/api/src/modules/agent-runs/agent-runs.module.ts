import { Module } from '@nestjs/common';
import { AgentRunsService } from './agent-runs.service';
import { AgentRunTimelineService } from './agent-run-timeline.service';
import { AgentRunsController } from './agent-runs.controller';

@Module({
  controllers: [AgentRunsController],
  providers: [AgentRunsService, AgentRunTimelineService],
  exports: [AgentRunsService, AgentRunTimelineService],
})
export class AgentRunsModule {}
