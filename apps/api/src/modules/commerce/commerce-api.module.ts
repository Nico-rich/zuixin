import { Module } from '@nestjs/common';
import { CommerceModule } from './commerce.module';
import { CommerceController } from './commerce.controller';

/**
 * HTTP 面（仅 API 进程挂载）：M13-W9 只读展示端点。
 * Worker 仍只经 CommerceModule 服务层走 Tool 路径——HTTP 面绝不成为第二写入口（"工具即接口"）。
 */
@Module({
  imports: [CommerceModule],
  controllers: [CommerceController],
})
export class CommerceApiModule {}
