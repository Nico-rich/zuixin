import { Module } from '@nestjs/common';
import { CreativeLoopModule } from './creative-loop.module';
import { CreativeLoopController } from './creative-loop.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫；Worker 只引 CreativeLoopModule 服务层 */
@Module({
  imports: [CreativeLoopModule],
  controllers: [CreativeLoopController],
})
export class CreativeLoopApiModule {}
