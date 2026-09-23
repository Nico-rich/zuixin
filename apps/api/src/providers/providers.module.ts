import { Global, Module } from '@nestjs/common';
import { LLMManagerService } from './llm/llm-manager.service';
import { ModelResolverService } from './llm/model-resolver.service';

@Global()
@Module({ providers: [LLMManagerService, ModelResolverService], exports: [LLMManagerService, ModelResolverService] })
export class ProvidersModule {}
