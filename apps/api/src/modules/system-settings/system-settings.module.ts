import { Module } from '@nestjs/common';
import { SystemSettingsService } from './system-settings.service';

/**
 * M12-P4 系统策略设置（服务层；API 与 Worker 共用）。
 * HTTP 面在 SystemSettingsApiModule（Worker 不引入 JWT 守卫）；
 * PrismaModule / AuditModule 均为 @Global，无需显式 import。
 */
@Module({
  providers: [SystemSettingsService],
  exports: [SystemSettingsService],
})
export class SystemSettingsModule {}
