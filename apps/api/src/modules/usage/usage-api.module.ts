import { Module } from '@nestjs/common';
import { UsageModule } from './usage.module';
import { UsageController } from './usage.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫 */
@Module({
  imports: [UsageModule],
  controllers: [UsageController],
})
export class UsageApiModule {}
