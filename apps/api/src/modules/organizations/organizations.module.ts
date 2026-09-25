import { Module } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { AuthorizationService } from './authorization.service';

/** M8-P1 服务层（API 与 Worker 共用；HTTP 面在 OrganizationsApiModule——Worker 不引入 JWT 守卫） */
@Module({
  providers: [OrganizationsService, AuthorizationService],
  exports: [OrganizationsService, AuthorizationService],
})
export class OrganizationsModule {}
