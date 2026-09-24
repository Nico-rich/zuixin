import { Module } from '@nestjs/common';
import { AgentRuntimeEngine } from './agent-runtime-engine';
import { PrismaRuntimePersistence } from './prisma-runtime-persistence';
import { AGENT_RUNTIME_PERSISTENCE } from './runtime-persistence';
import { ToolsModule } from '../tools/tools.module';
import { AgentRunsModule } from '../../modules/agent-runs/agent-runs.module';

/** M6-P2：Engine 与持久化边界注册（P3 Async Driver 复用同一 Engine） */
@Module({
  imports: [ToolsModule, AgentRunsModule],
  providers: [
    AgentRuntimeEngine,
    { provide: AGENT_RUNTIME_PERSISTENCE, useClass: PrismaRuntimePersistence },
  ],
  exports: [AgentRuntimeEngine, AGENT_RUNTIME_PERSISTENCE],
})
export class AgentLoopModule {}
