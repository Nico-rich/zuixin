import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { QuotaService } from './quota.service';
import { OrganizationsModule } from '../organizations/organizations.module';

/** M8-P2 服务层（API 与 Worker 共用——计量/配额在 worker 侧执行） */
@Module({
  imports: [OrganizationsModule],
  providers: [BillingService, QuotaService],
  exports: [BillingService, QuotaService],
})
export class BillingModule {}
