import { Module } from '@nestjs/common';
import { ProviderRoutingModule } from './provider-routing.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { RoutingController } from './routing.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫 */
@Module({
  imports: [ProviderRoutingModule, OrganizationsModule],
  controllers: [RoutingController],
})
export class ProviderRoutingApiModule {}
