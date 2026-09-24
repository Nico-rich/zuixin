import { Module } from '@nestjs/common';
import { ContextAssembler } from './context-assembler';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { MemoryModule } from '../memory/memory.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { MemoryService } from '../memory/memory.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ProjectMemorySource, UserMemorySource } from './sources/memory.sources';
import { KnowledgeSource } from './sources/knowledge.source';

/**
 * 上下文组装模块：内置最近消息源 + ProjectMemorySource / UserMemorySource / KnowledgeSource。
 * 未来 SummarySource / SystemPromptSource 在此按 CONTEXT_ORDER 注册。
 */
@Module({
  imports: [MemoryModule, KnowledgeModule],
  providers: [
    {
      provide: ContextAssembler,
      inject: [PrismaService, MemoryService, KnowledgeService],
      useFactory: (prisma: PrismaService, memories: MemoryService, knowledge: KnowledgeService) => {
        const assembler = new ContextAssembler(prisma);
        assembler.register(new ProjectMemorySource(memories));
        assembler.register(new UserMemorySource(memories));
        assembler.register(new KnowledgeSource(knowledge));
        return assembler;
      },
    },
  ],
  exports: [ContextAssembler],
})
export class ContextModule {}
