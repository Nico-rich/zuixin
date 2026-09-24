import { Global, Module } from '@nestjs/common';
import { UsageService } from './usage.service';

/** 服务层（@Global：API 与 Worker 共用）；HTTP 面在 UsageApiModule（Worker 不引入 JWT 守卫） */
@Global()
@Module({ providers: [UsageService], exports: [UsageService] })
export class UsageModule {}
