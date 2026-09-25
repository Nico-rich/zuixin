import { Module } from '@nestjs/common';
import { AnalyticsModule } from './analytics.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AnalyticsController } from './analytics.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫 + 组织成员校验 */
@Module({
  imports: [AnalyticsModule, OrganizationsModule],
  controllers: [AnalyticsController],
})
export class AnalyticsApiModule {}
