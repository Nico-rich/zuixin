import { Module } from '@nestjs/common';
import { ProvidersAdminModule } from './providers-admin.module';
import { ProvidersAdminController } from './providers-admin.controller';

/** M13+（模型配置页）HTTP 面（仅 API 进程注册；照 system-settings-api.module 范式） */
@Module({
  imports: [ProvidersAdminModule],
  controllers: [ProvidersAdminController],
})
export class ProvidersAdminApiModule {}
