import { Module } from '@nestjs/common';
import { ProvidersAdminService } from './providers-admin.service';

/**
 * M13+（模型配置页）Provider 管理服务层模块。
 * 依赖（PrismaService/CryptoService/AuditService/四 manager）全部 @Global 提供，无需 imports。
 * HTTP 面在 providers-admin-api.module（Worker 进程不引入控制器）。
 */
@Module({
  providers: [ProvidersAdminService],
  exports: [ProvidersAdminService],
})
export class ProvidersAdminModule {}
