import { Module } from '@nestjs/common';
import { ExtensionsModule } from './extensions.module';
import { ExtensionsController } from './extensions.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫 */
@Module({
  imports: [ExtensionsModule],
  controllers: [ExtensionsController],
})
export class ExtensionsApiModule {}
