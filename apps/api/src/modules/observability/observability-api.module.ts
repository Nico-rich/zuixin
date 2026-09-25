import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ObservabilityController } from './observability.controller';

/**
 * M8-P3 观测 HTTP 面（仅 API 进程挂载）：controller + JWT 守卫。
 * ObservabilityService 由 @Global TracingModule 提供（AppModule imports 已注册）。
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [ObservabilityController],
})
export class ObservabilityApiModule {}
