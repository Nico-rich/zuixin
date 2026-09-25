import { Global, Module } from '@nestjs/common';
import { UsageService } from './usage.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { BillingModule } from '../billing/billing.module';

/** 服务层（@Global：API 与 Worker 共用）；HTTP 面在 UsageApiModule（Worker 不引入 JWT 守卫） */
@Global()
@Module({
  imports: [OrganizationsModule, BillingModule],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
