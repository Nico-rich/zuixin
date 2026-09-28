import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { ConversationsController } from './conversations.controller';
import { MemoryModule } from '../../core/memory/memory.module';

// M9-P2：删除会话需清理摘要版本链（隐私传播）→ 依赖记忆域（MemoryModule 无反向依赖，无循环）
@Module({
  imports: [MemoryModule],
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
