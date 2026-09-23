import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { ContextModule } from '../../core/context/context.module';
import { MemoryModule } from '../../core/memory/memory.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AgentsModule } from '../../agents/agents.module';

@Module({
  imports: [ContextModule, MemoryModule, AttachmentsModule, AgentsModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
