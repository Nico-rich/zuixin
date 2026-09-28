import { Module } from '@nestjs/common';
import { WorkflowsModule } from './workflows.module';
import { WorkflowsController } from './workflows.controller';
import { WorkflowRunsController } from './workflow-runs.controller';
import { WorkflowHooksController } from './workflow-hooks.controller';
import { WebhookGlobalThrottleGuard } from './webhook-global-throttle.guard';

/** HTTP 面（仅 API 进程挂载）：管理端点 + 公开 webhook 端点 */
@Module({
  imports: [WorkflowsModule],
  controllers: [WorkflowsController, WorkflowRunsController, WorkflowHooksController],
  // M10-P5 SA-16/SA-17：webhook 全局总闸（仅 HTTP 面；RateLimitService 来自全局 RateLimitModule）
  providers: [WebhookGlobalThrottleGuard],
})
export class WorkflowsApiModule {}
