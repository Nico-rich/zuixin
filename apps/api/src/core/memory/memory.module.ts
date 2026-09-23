import { Module } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { LLMMemoryExtractor, MEMORY_EXTRACTOR } from './memory-extractor';

@Module({
  providers: [MemoryService, { provide: MEMORY_EXTRACTOR, useClass: LLMMemoryExtractor }],
  exports: [MemoryService, MEMORY_EXTRACTOR],
})
export class MemoryModule {}
