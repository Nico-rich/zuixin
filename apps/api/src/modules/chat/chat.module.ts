import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { LLMManagerService } from '../../providers/llm/llm-manager.service';
import { ResolvedLLM } from '../../providers/llm/llm-manager.service';
import { ChatAgent } from '../../agents/chat/chat.agent';
import { ContextModule } from '../../core/context/context.module';
import { MemoryModule } from '../../core/memory/memory.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { GenerationsModule } from '../generations/generations.module';
import { MediaGenerationService } from '../generations/media-generation.service';
import { ImageAgent } from '../../agents/image/image.agent';
import { VideoAgent } from '../../agents/video/video.agent';

@Module({
  imports: [ContextModule, MemoryModule, AttachmentsModule, GenerationsModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    {
      provide: 'CHAT_AGENT_FACTORY',
      useFactory: (llmManager: LLMManagerService) => ({
        create: (input: { resolved: ResolvedLLM }) =>
          new ChatAgent({ llmManager }, { resolveLLM: async () => ({ adapter: input.resolved.adapter, apiModelId: input.resolved.apiModelId }) }),
      }),
      inject: [LLMManagerService],
    },
    {
      provide: 'IMAGE_AGENT_FACTORY',
      useFactory: (generations: MediaGenerationService) => ({
        create: () => new ImageAgent({ generations }),
      }),
      inject: [MediaGenerationService],
    },
    {
      provide: 'VIDEO_AGENT_FACTORY',
      useFactory: (generations: MediaGenerationService) => ({
        create: () => new VideoAgent({ generations }),
      }),
      inject: [MediaGenerationService],
    },
  ],
})
export class ChatModule {}
