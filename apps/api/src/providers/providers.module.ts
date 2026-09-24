import { Global, Module } from '@nestjs/common';
import { LLMManagerService } from './llm/llm-manager.service';
import { ModelResolverService } from './llm/model-resolver.service';
import { ImageManagerService } from './image/image-manager.service';
import { VideoManagerService } from './video/video-manager.service';
import { EmbeddingManagerService } from './embedding/embedding-manager.service';

@Global()
@Module({
  providers: [LLMManagerService, ModelResolverService, ImageManagerService, VideoManagerService, EmbeddingManagerService],
  exports: [LLMManagerService, ModelResolverService, ImageManagerService, VideoManagerService, EmbeddingManagerService],
})
export class ProvidersModule {}
