import { Module } from '@nestjs/common';
import { QueueModule } from '../../core/queue/queue.module';
import { ToolsModule } from '../../core/tools/tools.module';
import { ExternalActionsModule } from '../external-actions/external-actions.module';
import { AgentRunsModule } from '../agent-runs/agent-runs.module';
import { WorkflowsService } from './workflows.service';
import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowExecutor } from './workflow-executor.service';
import { WorkflowTriggersService } from './workflow-triggers.service';

/** M7-P6 服务层（API 与 Worker 共用；HTTP 面在 WorkflowsApiModule——Worker 不引入 JWT 守卫） */
@Module({
  imports: [QueueModule, ToolsModule, ExternalActionsModule, AgentRunsModule],
  providers: [WorkflowsService, WorkflowRunsService, WorkflowExecutor, WorkflowTriggersService],
  exports: [WorkflowsService, WorkflowRunsService, WorkflowExecutor, WorkflowTriggersService],
})
export class WorkflowsModule {}
