import { Module } from '@nestjs/common';
import { BillingModule } from './billing.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { BillingController } from './billing.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫 */
@Module({
  imports: [BillingModule, OrganizationsModule],
  controllers: [BillingController],
})
export class BillingApiModule {}
