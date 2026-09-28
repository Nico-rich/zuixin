import { Module } from '@nestjs/common';
import { QueueModule } from '../../core/queue/queue.module';
import { ToolsModule } from '../../core/tools/tools.module';
import { ExternalActionsModule } from '../external-actions/external-actions.module';
import { AgentRunsModule } from '../agent-runs/agent-runs.module';
import { WorkflowsService } from './workflows.service';
import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowExecutor } from './workflow-executor.service';
import { WorkflowTriggersService } from './workflow-triggers.service';
import { WorkflowWaitService } from './workflow-wait.service'; // M9-P4：wait 条件解析/判定（纯逻辑）
import { WorkflowCompensationService } from './workflow-compensation.service'; // M9-P4：逆序补偿链
import { OrganizationsModule } from '../organizations/organizations.module';
import { BillingModule } from '../billing/billing.module';

/** M7-P6 服务层（API 与 Worker 共用；HTTP 面在 WorkflowsApiModule——Worker 不引入 JWT 守卫） */
@Module({
  imports: [QueueModule, ToolsModule, ExternalActionsModule, AgentRunsModule, OrganizationsModule, BillingModule],
  providers: [
    WorkflowsService, WorkflowRunsService, WorkflowExecutor, WorkflowTriggersService,
    WorkflowWaitService, WorkflowCompensationService, // M9-P4
  ],
  // BillingModule 再导出：Worker 侧 WorkflowLeaseService 需注入 QuotaService（C1 预留释放）
  exports: [
    WorkflowsService, WorkflowRunsService, WorkflowExecutor, WorkflowTriggersService,
    WorkflowWaitService, WorkflowCompensationService, // M9-P4
    BillingModule,
  ],
})
export class WorkflowsModule {}
