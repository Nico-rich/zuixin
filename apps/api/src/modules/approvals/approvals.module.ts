import { Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { AgentRunResumeModule } from '../../core/agent-run-resume/agent-run-resume.module';

/** 服务层（API 与 Worker 共用；HTTP 面在 ApprovalsApiModule——Worker 不引入 JWT 守卫） */
@Module({
  imports: [AgentRunResumeModule],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
