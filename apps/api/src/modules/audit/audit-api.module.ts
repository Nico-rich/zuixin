import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';

/** HTTP 面（仅 API 进程挂载）；AuditService 由 @Global AuditModule 提供 */
@Module({ controllers: [AuditController] })
export class AuditApiModule {}
