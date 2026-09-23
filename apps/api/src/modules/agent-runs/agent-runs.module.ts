import { Module } from '@nestjs/common';
import { AgentRunsService } from './agent-runs.service';
import { AgentRunsController } from './agent-runs.controller';

@Module({ controllers: [AgentRunsController], providers: [AgentRunsService], exports: [AgentRunsService] })
export class AgentRunsModule {}
