import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { ProviderPoliciesService } from './policies.service';
import { ProviderCapabilitiesService } from './capabilities.service';
import { OrganizationsModule } from '../organizations/organizations.module';

/** M8-P7 服务层（API 与 Worker 共用；HTTP 面在 ProviderRoutingApiModule——Worker 不挂 JWT 守卫） */
@Module({
  imports: [OrganizationsModule],
  providers: [RoutingService, ProviderPoliciesService, ProviderCapabilitiesService],
  exports: [RoutingService, ProviderPoliciesService, ProviderCapabilitiesService],
})
export class ProviderRoutingModule {}
