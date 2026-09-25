import { Module } from '@nestjs/common';
import { WorkflowsModule } from './workflows.module';
import { WorkflowsController } from './workflows.controller';
import { WorkflowRunsController } from './workflow-runs.controller';
import { WorkflowHooksController } from './workflow-hooks.controller';

/** HTTP 面（仅 API 进程挂载）：管理端点 + 公开 webhook 端点 */
@Module({
  imports: [WorkflowsModule],
  controllers: [WorkflowsController, WorkflowRunsController, WorkflowHooksController],
})
export class WorkflowsApiModule {}
