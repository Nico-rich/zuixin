import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { MEDIA_CLEANUP_QUEUE } from '../../core/queue/queue.module';
import { MediaCleanupService } from '../../modules/generations/media-cleanup.service';

const SWEEP_INTERVAL_MS = 5 * 60_000;

/** 清扫处理器：执行一次孤儿任务扫描（幂等，多 Worker 安全） */
@Processor(MEDIA_CLEANUP_QUEUE)
export class MediaCleanupProcessor extends WorkerHost {
  constructor(@Inject(MediaCleanupService) private readonly cleanup: MediaCleanupService) {
    super();
  }

  async process(_job: Job): Promise<number> {
    return this.cleanup.sweep();
  }
}

/** 周期调度：每 5 分钟投递一次 sweep 作业（Worker 进程侧） */
@Injectable()
export class MediaCleanupScheduler implements OnModuleInit {
  constructor(@InjectQueue(MEDIA_CLEANUP_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler('media-cleanup-scheduler', { every: SWEEP_INTERVAL_MS }, { name: 'sweep' });
  }
}
