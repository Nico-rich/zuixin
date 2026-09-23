import { Global, Module } from '@nestjs/common';
import { LLMManagerService } from './llm/llm-manager.service';
import { ModelResolverService } from './llm/model-resolver.service';
import { ImageManagerService } from './image/image-manager.service';
import { VideoManagerService } from './video/video-manager.service';

@Global()
@Module({
  providers: [LLMManagerService, ModelResolverService, ImageManagerService, VideoManagerService],
  exports: [LLMManagerService, ModelResolverService, ImageManagerService, VideoManagerService],
})
export class ProvidersModule {}
