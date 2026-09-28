import { Module } from '@nestjs/common';
import { OrganizationsModule } from './organizations.module';
import { OrganizationsController, InvitationsController } from './organizations.controller';
import { OrgStatusGuard } from '../../common/guards/org-status.guard';

/**
 * HTTP 面（仅 API 进程挂载）：controller + JWT 守卫 + M10-P14 组织禁用守卫。
 * OrgStatusGuard 在此显式提供（依赖的 PrismaService 为 @Global）；集成阶段由 app.module 全局挂载同一守卫。
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [OrganizationsController, InvitationsController],
  providers: [OrgStatusGuard],
})
export class OrganizationsApiModule {}
