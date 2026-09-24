import { Module } from '@nestjs/common';
import { ContextAssembler } from './context-assembler';
import { ContextBudgetService } from './context-budget.service';
import { SimpleTokenEstimator } from './token-estimator';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { MemoryModule } from '../memory/memory.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { MemoryService } from '../memory/memory.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ProjectMemorySource, UserMemorySource } from './sources/memory.sources';
import { KnowledgeSource } from './sources/knowledge.source';

/**
 * 上下文组装模块：内置最近消息源 + ProjectMemorySource / UserMemorySource / KnowledgeSource
 * + ContextBudgetService（统一预算决策）。未来 SummarySource / SystemPromptSource 在此注册。
 */
@Module({
  imports: [MemoryModule, KnowledgeModule],
  providers: [
    { provide: 'TOKEN_ESTIMATOR', useClass: SimpleTokenEstimator },
    ContextBudgetService,
    {
      provide: ContextAssembler,
      inject: [PrismaService, MemoryService, KnowledgeService, ContextBudgetService],
      useFactory: (prisma: PrismaService, memories: MemoryService, knowledge: KnowledgeService, budget: ContextBudgetService) => {
        const assembler = new ContextAssembler(prisma, budget);
        assembler.register(new ProjectMemorySource(memories));
        assembler.register(new UserMemorySource(memories));
        assembler.register(new KnowledgeSource(knowledge));
        return assembler;
      },
    },
  ],
  exports: [ContextAssembler, ContextBudgetService],
})
export class ContextModule {}
