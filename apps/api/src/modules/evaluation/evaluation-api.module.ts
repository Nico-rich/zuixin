import { Module } from '@nestjs/common';
import { EvaluationModule } from './evaluation.module';
import { EvaluationController } from './evaluation.controller';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';

/**
 * HTTP 面（仅 API 进程挂载）：controller + JWT 守卫；Worker 只引 EvaluationModule 服务层。
 * M12-P4：controller 注入 SystemSettingsService（晋级确认的平台管理员裁决——与策略写入口同一判定，单一事实源）。
 */
@Module({
  imports: [EvaluationModule, OrganizationsModule, SystemSettingsModule],
  controllers: [EvaluationController],
})
export class EvaluationApiModule {}
