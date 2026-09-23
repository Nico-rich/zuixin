import { Global, Module } from '@nestjs/common';
import { LLMManagerService } from './llm/llm-manager.service';

@Global()
@Module({ providers: [LLMManagerService], exports: [LLMManagerService] })
export class ProvidersModule {}
