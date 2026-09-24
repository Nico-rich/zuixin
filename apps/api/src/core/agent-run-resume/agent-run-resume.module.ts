import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { AgentRunResumeTrigger } from './agent-run-resume-trigger.service';

/** M6-P4：GenerationTask 终态唤醒（waiting→queued）；无 HTTP 依赖，API/Worker 共用 */
@Module({
  imports: [QueueModule],
  providers: [AgentRunResumeTrigger],
  exports: [AgentRunResumeTrigger],
})
export class AgentRunResumeModule {}
