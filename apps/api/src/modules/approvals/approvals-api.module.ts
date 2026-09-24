import { Module } from '@nestjs/common';
import { ApprovalsModule } from './approvals.module';
import { ApprovalsController } from './approvals.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫 */
@Module({
  imports: [ApprovalsModule],
  controllers: [ApprovalsController],
})
export class ApprovalsApiModule {}
