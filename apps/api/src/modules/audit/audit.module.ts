import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/** 全局审计模块（服务层各处注入；无 HTTP 依赖——Worker 也可用） */
@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
