import { Module } from '@nestjs/common';
import { QueueModule } from '../../core/queue/queue.module';
import { WorkflowsModule } from '../../modules/workflows/workflows.module';
import { WorkflowLeaseService } from './workflow-lease.service';
import { WorkflowWakeService } from './workflow-wake.service';
import { WorkflowProcessor } from './workflow.processor';

/** M7-P6 Workflow Worker（processor + lease + wake；executor/服务层复用 WorkflowsModule） */
@Module({
  imports: [QueueModule, WorkflowsModule],
  providers: [WorkflowLeaseService, WorkflowWakeService, WorkflowProcessor],
  exports: [WorkflowLeaseService, WorkflowWakeService],
})
export class WorkflowWorkerModule {}
