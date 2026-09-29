import { Module } from '@nestjs/common';
import { SystemSettingsModule } from './system-settings.module';
import { SystemSettingsController } from './system-settings.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫；Worker 只引 SystemSettingsModule 服务层 */
@Module({
  imports: [SystemSettingsModule],
  controllers: [SystemSettingsController],
})
export class SystemSettingsApiModule {}
