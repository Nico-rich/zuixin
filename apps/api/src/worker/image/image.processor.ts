import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { IMAGE_QUEUE } from '../../core/queue/queue.module';
import { ImageGenerationService } from '../../modules/generations/image-generation.service';

/** Worker 侧生图消费者：只做入参解析，逻辑全部在 ImageGenerationService（与 API 侧共享） */
@Processor(IMAGE_QUEUE)
export class ImageProcessor extends WorkerHost {
  constructor(@Inject(ImageGenerationService) private readonly generations: ImageGenerationService) {
    super();
  }

  async process(job: Job<{ taskId: string }>): Promise<void> {
    await this.generations.executeTask(job.data.taskId);
  }
}
