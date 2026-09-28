import { Module } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { LLMMemoryExtractor, MEMORY_EXTRACTOR } from './memory-extractor';
import { SummaryRefinerService } from './summary-refiner.service';
import { MemoryCandidateService } from './memory-candidate.service';

/**
 * 记忆域（M2 基础 + M9-P2 增量摘要/候选提炼）。
 * 依赖 PrismaService / ModelResolverService 均为全局模块提供（PrismaModule / ProvidersModule）。
 */
@Module({
  providers: [
    MemoryService,
    { provide: MEMORY_EXTRACTOR, useClass: LLMMemoryExtractor },
    SummaryRefinerService,
    MemoryCandidateService,
  ],
  exports: [MemoryService, MEMORY_EXTRACTOR, SummaryRefinerService, MemoryCandidateService],
})
export class MemoryModule {}
