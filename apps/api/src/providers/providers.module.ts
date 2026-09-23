import { Global, Module } from '@nestjs/common';
import { LLMManagerService } from './llm/llm-manager.service';
import { ModelResolverService } from './llm/model-resolver.service';
import { ImageManagerService } from './image/image-manager.service';

@Global()
@Module({
  providers: [LLMManagerService, ModelResolverService, ImageManagerService],
  exports: [LLMManagerService, ModelResolverService, ImageManagerService],
})
export class ProvidersModule {}
