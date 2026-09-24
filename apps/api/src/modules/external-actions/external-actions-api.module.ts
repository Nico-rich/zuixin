import { Module } from '@nestjs/common';
import { ExternalActionsModule } from './external-actions.module';
import { ExternalActionsController } from './external-actions.controller';

/** HTTP 面（仅 API 进程挂载）：审计读取端点 */
@Module({
  imports: [ExternalActionsModule],
  controllers: [ExternalActionsController],
})
export class ExternalActionsApiModule {}
