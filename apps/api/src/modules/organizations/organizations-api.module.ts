import { Module } from '@nestjs/common';
import { OrganizationsModule } from './organizations.module';
import { OrganizationsController, InvitationsController } from './organizations.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫 */
@Module({
  imports: [OrganizationsModule],
  controllers: [OrganizationsController, InvitationsController],
})
export class OrganizationsApiModule {}
