import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { QuotaService } from './quota.service';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { QueueModule } from '../../core/queue/queue.module';

/** M8-P2 服务层（API 与 Worker 共用——计量/配额在 worker 侧执行）；M8-P9 追加 QueueModule（背压读队列深度）；
 *  Pre-M9 D1 追加对账服务（UsageRecord ↔ UsageLedgerEntry 漂移诊断） */
@Module({
  imports: [OrganizationsModule, QueueModule],
  providers: [BillingService, QuotaService, BillingReconciliationService],
  exports: [BillingService, QuotaService, BillingReconciliationService],
})
export class BillingModule {}
