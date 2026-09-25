import { Module } from '@nestjs/common';
import { GenerationsModule } from '../../modules/generations/generations.module';
import { QueueModule } from '../../core/queue/queue.module';
import { AgentRunLeaseModule } from '../../core/agent-run-lease/agent-run-lease.module';
import { WorkflowWorkerModule } from '../workflow/workflow-worker.module';
import { MediaCleanupProcessor, MediaCleanupScheduler } from './media-cleanup.worker';

/** 仅 Worker 进程挂载：周期清扫 scheduling + sweep 处理器 + async run / workflow run stale recovery */
@Module({ imports: [GenerationsModule, QueueModule, AgentRunLeaseModule, WorkflowWorkerModule], providers: [MediaCleanupProcessor, MediaCleanupScheduler] })
export class MediaCleanupWorkerModule {}
