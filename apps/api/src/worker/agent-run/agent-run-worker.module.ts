import { Module } from '@nestjs/common';
import { QueueModule } from '../../core/queue/queue.module';
import { AgentRunLeaseModule } from '../../core/agent-run-lease/agent-run-lease.module';
import { AgentLoopModule } from '../../core/agent-loop/agent-loop.module';
import { ContextModule } from '../../core/context/context.module';
import { AgentRunProcessor } from './agent-run.processor';
import { AsyncAgentRunDriver } from './async-agent-run.driver';

/** M6-P3：AgentRun 异步执行（Worker 进程侧）——Engine/Context/Lease 全部复用，不自建 Runtime */
@Module({
  imports: [QueueModule, AgentRunLeaseModule, AgentLoopModule, ContextModule],
  providers: [AgentRunProcessor, AsyncAgentRunDriver],
})
export class AgentRunWorkerModule {}
