import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

export const IMAGE_QUEUE = 'image';
export const VIDEO_QUEUE = 'video';
export const MEDIA_CLEANUP_QUEUE = 'media-cleanup';
export const AGENT_RUN_QUEUE = 'agent-run'; // M6-P3：异步 AgentRun 执行队列（payload 仅 {runId}）
export const WORKFLOW_QUEUE = 'workflow'; // M7-P6：WorkflowRun 执行队列（payload {runId} | {kind:'scheduled', workflowId}）
export const EVALUATION_QUEUE = 'evaluation'; // M9-P1：EvaluationRun 执行队列（payload {runId}）

@Module({
  imports: [
    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null },
    }),
    BullModule.registerQueue(
      { name: IMAGE_QUEUE }, { name: VIDEO_QUEUE }, { name: MEDIA_CLEANUP_QUEUE }, { name: AGENT_RUN_QUEUE }, { name: WORKFLOW_QUEUE }, { name: EVALUATION_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
