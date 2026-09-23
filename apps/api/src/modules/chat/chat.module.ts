import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { LLMManagerService } from '../../providers/llm/llm-manager.service';
import { ResolvedLLM } from '../../providers/llm/llm-manager.service';
import { ChatAgent } from '../../agents/chat/chat.agent';

@Module({
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
  ],
})
export class ChatModule {}
