import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeModule as CoreKnowledgeModule } from '../../core/knowledge/knowledge.module';

@Module({
  imports: [CoreKnowledgeModule],
  controllers: [KnowledgeController],
})
export class KnowledgeApiModule {}
