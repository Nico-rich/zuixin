import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueModule } from './queue.module';

/** M8-P5 调度队列名（与既有 image/video/media-cleanup/agent-run/workflow 队列并列，互不干扰） */
export const SCHEDULER_QUEUE = 'scheduler';

/**
 * M8-P5 Scheduler 队列注册（独立模块，避免改动冻结的 QueueModule）：
 * BullMQ 的 forRoot（连接配置）在 QueueModule 内且标记 global——此处 import QueueModule 保证
 * 配置可用，registerQueue 仅为 'scheduler' 生成队列 provider，再随 BullModule 导出给 SchedulerModule。
 * 队列与既有队列隔离：调度作业是通用 delayed/repeatable 作业，绝不与 workflow run 抢同一队列。
 */
@Module({
  imports: [QueueModule, BullModule.registerQueue({ name: SCHEDULER_QUEUE })],
  exports: [BullModule],
})
export class SchedulerQueueModule {}
