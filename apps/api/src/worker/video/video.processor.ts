import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { VIDEO_QUEUE } from '../../core/queue/queue.module';
import { MediaGenerationService } from '../../modules/generations/media-generation.service';

/** Worker 侧视频消费者：只做入参解析，逻辑全部在 MediaGenerationService（与 API 侧共享） */
@Processor(VIDEO_QUEUE)
export class VideoProcessor extends WorkerHost {
  constructor(@Inject(MediaGenerationService) private readonly generations: MediaGenerationService) {
    super();
  }

  async process(job: Job<{ taskId: string }>): Promise<void> {
    await this.generations.executeTask(job.data.taskId);
  }
}
