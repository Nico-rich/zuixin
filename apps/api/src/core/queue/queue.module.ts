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
    // M10 集成修复（A1/A12 实抓的潜伏缺陷）：forRoot 静态配置在模块**导入期**读 REDIS_URL——
    // spec 的 beforeAll 赋值对队列无效（并行 worktree 全落 DB0）。改 factory 在**编译期**惰性读取。
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null },
      }),
    }),
    BullModule.registerQueue(
      { name: IMAGE_QUEUE }, { name: VIDEO_QUEUE }, { name: MEDIA_CLEANUP_QUEUE }, { name: AGENT_RUN_QUEUE }, { name: WORKFLOW_QUEUE }, { name: EVALUATION_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
