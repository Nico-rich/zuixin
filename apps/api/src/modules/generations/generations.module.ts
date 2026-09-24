import { Module } from '@nestjs/common';
import { MediaGenerationService } from './media-generation.service';
import { MediaCleanupService } from './media-cleanup.service';
import { MediaExecutor } from './media-types';
import { ImageExecutor } from './executors/image.executor';
import { VideoExecutor } from './executors/video.executor';
import { QueueModule } from '../../core/queue/queue.module';
import { EventsModule } from '../../core/events/events.module';
import { ModelRouterModule } from '../../core/model-router/model-router.module';
import { AgentRunResumeModule } from '../../core/agent-run-resume/agent-run-resume.module';

@Module({
  imports: [QueueModule, EventsModule, ModelRouterModule, AgentRunResumeModule],
  providers: [
    MediaGenerationService,
    MediaCleanupService,
    {
      // 执行器注册表：image / video 独立实现（不互继承），按 task.type 分发
      provide: 'MEDIA_EXECUTORS',
      inject: [ImageExecutor, VideoExecutor],
      useFactory: (imageExecutor: ImageExecutor, videoExecutor: VideoExecutor): Map<string, MediaExecutor> =>
        new Map<string, MediaExecutor>([[imageExecutor.type, imageExecutor], [videoExecutor.type, videoExecutor]]),
    },
    ImageExecutor,
    VideoExecutor,
  ],
  exports: [MediaGenerationService, MediaCleanupService],
})
export class GenerationsModule {}
