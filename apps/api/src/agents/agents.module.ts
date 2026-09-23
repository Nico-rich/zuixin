import { Global, Module } from '@nestjs/common';
import { AgentRegistryService } from './agent-registry.service';
import { AgentLoopModule } from '../core/agent-loop/agent-loop.module';
import { ContextModule } from '../core/context/context.module';
import { GenerationsModule } from '../modules/generations/generations.module';

@Global()
@Module({
  imports: [AgentLoopModule, ContextModule, GenerationsModule],
  providers: [AgentRegistryService],
  exports: [AgentRegistryService],
})
export class AgentsModule {}
