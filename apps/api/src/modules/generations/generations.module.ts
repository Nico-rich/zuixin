import { Module } from '@nestjs/common';
import { ImageGenerationService } from './image-generation.service';
import { QueueModule } from '../../core/queue/queue.module';
import { EventsModule } from '../../core/events/events.module';
import { ModelRouterModule } from '../../core/model-router/model-router.module';

@Module({
  imports: [QueueModule, EventsModule, ModelRouterModule],
  providers: [ImageGenerationService],
  exports: [ImageGenerationService],
})
export class GenerationsModule {}
