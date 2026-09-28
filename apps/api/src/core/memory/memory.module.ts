import { Module } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { LLMMemoryExtractor, MEMORY_EXTRACTOR } from './memory-extractor';
import { SummaryRefinerService } from './summary-refiner.service';
import { MemoryCandidateService } from './memory-candidate.service';
import { UsageModule } from '../../modules/usage/usage.module';

/**
 * 记忆域（M2 基础 + M9-P2 增量摘要/候选提炼）。
 * 依赖 PrismaService / ModelResolverService 均为全局模块提供（PrismaModule / ProvidersModule）。
 * M10 Final Audit H4：引入 UsageModule——摘要重建 LLM 调用计量（UsageService）。
 */
@Module({
  imports: [UsageModule],
  providers: [
    MemoryService,
    { provide: MEMORY_EXTRACTOR, useClass: LLMMemoryExtractor },
    SummaryRefinerService,
    MemoryCandidateService,
  ],
  exports: [MemoryService, MEMORY_EXTRACTOR, SummaryRefinerService, MemoryCandidateService],
})
export class MemoryModule {}
