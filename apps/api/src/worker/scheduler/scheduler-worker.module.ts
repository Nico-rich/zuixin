import { Module } from '@nestjs/common';
import { SchedulerQueueModule } from '../../core/queue/scheduler-queue.module';
import { SchedulerModule } from '../../modules/scheduler/scheduler.module';
import { EventPlatformModule } from '../../modules/events/event-platform.module';
import { SchedulerProcessor } from './scheduler.processor';

/**
 * M8-P5 Scheduler Worker（processor 消费 'scheduler' 队列；concurrency=2）。
 * handler 注册表由进程内注册（worker 启动时 registerHandler）——未注册 handler 一律判失败，
 * 绝不动态执行任何字符串（安全底线）。作业执行结果经事件平台落 EventEnvelope 行。
 */
@Module({
  imports: [SchedulerQueueModule, SchedulerModule, EventPlatformModule],
  providers: [SchedulerProcessor],
})
export class SchedulerWorkerModule {}
