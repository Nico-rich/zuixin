import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

export const IMAGE_QUEUE = 'image';
export const VIDEO_QUEUE = 'video';

@Module({
  imports: [
    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null },
    }),
    BullModule.registerQueue({ name: IMAGE_QUEUE }, { name: VIDEO_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
