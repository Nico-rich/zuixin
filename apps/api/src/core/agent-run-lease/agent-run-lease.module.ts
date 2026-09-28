import { Module } from '@nestjs/common';
import { AgentRunLeaseService } from './agent-run-lease.service';
import { QueueModule } from '../queue/queue.module';
import { BillingModule } from '../../modules/billing/billing.module';

@Module({
  // M10 Final Audit H2c：recoverStale 需释放 C1 预留（BillingModule 导出 QuotaService）
  imports: [QueueModule, BillingModule],
  providers: [AgentRunLeaseService],
  exports: [AgentRunLeaseService],
})
export class AgentRunLeaseModule {}
