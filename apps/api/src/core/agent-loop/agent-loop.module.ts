import { Module } from '@nestjs/common';
import { AgentLoopService } from './agent-loop.service';
import { ToolsModule } from '../tools/tools.module';

@Module({ imports: [ToolsModule], providers: [AgentLoopService], exports: [AgentLoopService] })
export class AgentLoopModule {}
