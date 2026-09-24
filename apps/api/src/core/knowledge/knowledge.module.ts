import { Module } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeRepository } from './knowledge.repository';
import { ChunkingService } from './chunking.service';

@Module({
  providers: [KnowledgeService, KnowledgeRepository, ChunkingService],
  exports: [KnowledgeService, KnowledgeRepository, ChunkingService],
})
export class KnowledgeModule {}
