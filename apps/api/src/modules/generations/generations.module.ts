import { Module } from '@nestjs/common';
import { MediaGenerationService } from './media-generation.service';
import { MediaCleanupService } from './media-cleanup.service';
import { ImageExecutor } from './executors/image.executor';
import { QueueModule } from '../../core/queue/queue.module';
import { EventsModule } from '../../core/events/events.module';
import { ModelRouterModule } from '../../core/model-router/model-router.module';

@Module({
  imports: [QueueModule, EventsModule, ModelRouterModule],
  providers: [
    MediaGenerationService,
    MediaCleanupService,
    {
      // 执行器注册表：image / video 独立实现，按 task.type 分发（M3-4 追加 VideoExecutor）
      provide: 'MEDIA_EXECUTORS',
      inject: [ImageExecutor],
      useFactory: (imageExecutor: ImageExecutor) => new Map([[imageExecutor.type, imageExecutor]]),
    },
    ImageExecutor,
  ],
  exports: [MediaGenerationService, MediaCleanupService],
})
export class GenerationsModule {}
