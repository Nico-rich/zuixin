import { Module } from '@nestjs/common';
import { ArtifactsModule } from './artifacts.module';
import { ArtifactsController } from './artifacts.controller';

/** HTTP 面（仅 API 进程挂载；Worker 走 ArtifactsModule 服务层，不引入 JWT 守卫）——与 approvals 同构 */
@Module({
  imports: [ArtifactsModule],
  controllers: [ArtifactsController],
})
export class ArtifactsApiModule {}
