import { Module } from '@nestjs/common';
import { ContextAssembler } from './context-assembler';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { MemoryModule } from '../memory/memory.module';
import { MemoryService } from '../memory/memory.service';
import { ProjectMemorySource, UserMemorySource } from './sources/memory.sources';

/**
 * 上下文组装模块：内置最近消息源 + M2 注册 ProjectMemorySource / UserMemorySource。
 * 未来 SummarySource / KnowledgeSource（RAG）/ SystemPromptSource 在此按 CONTEXT_ORDER 注册。
 */
@Module({
  imports: [MemoryModule],
  providers: [
    {
      provide: ContextAssembler,
      inject: [PrismaService, MemoryService],
      useFactory: (prisma: PrismaService, memories: MemoryService) => {
        const assembler = new ContextAssembler(prisma);
        assembler.register(new ProjectMemorySource(memories));
        assembler.register(new UserMemorySource(memories));
        return assembler;
      },
    },
  ],
  exports: [ContextAssembler],
})
export class ContextModule {}
