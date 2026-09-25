import { Module } from '@nestjs/common';
import { ExtensionsService } from './extensions.service';
import { ToolsModule } from '../../core/tools/tools.module';
import { OrganizationsModule } from '../organizations/organizations.module';

/**
 * M8-P6 服务层（API 与 Worker 共用；HTTP 面在 ExtensionsApiModule——Worker 不引入 JWT 守卫）。
 * 注入 ToolRegistry 在运行期 register/unregister 扩展工具（绝不修改 ToolsModule/内置工具）。
 */
@Module({
  imports: [ToolsModule, OrganizationsModule],
  providers: [ExtensionsService],
  exports: [ExtensionsService],
})
export class ExtensionsModule {}
