import { Module } from '@nestjs/common';
import { AgentRunsModule } from './agent-runs.module';
import { AgentRunsController } from './agent-runs.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫；Worker 只引 AgentRunsModule 服务层 */
@Module({
  imports: [AgentRunsModule],
  controllers: [AgentRunsController],
})
export class AgentRunsApiModule {}
