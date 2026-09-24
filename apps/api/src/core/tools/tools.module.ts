import { Module } from '@nestjs/common';
import { ToolRegistry } from './tool-registry.service';
import { GenerationsModule } from '../../modules/generations/generations.module';
import { ArtifactsModule } from '../../modules/artifacts/artifacts.module';
import { MemoryModule } from '../memory/memory.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { MediaGenerationService } from '../../modules/generations/media-generation.service';
import { ArtifactService } from '../../modules/artifacts/artifact.service';
import { MemoryService } from '../memory/memory.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { createArtifactTool, createImageGenerateTool, createMemoryCandidateTool, createVideoGenerateTool } from './builtin/tools';
import { createKnowledgeSearchTool } from './builtin/knowledge.tool';
import { createExternalActionDemoTool } from './builtin/approval.tool';

@Module({
  imports: [GenerationsModule, ArtifactsModule, MemoryModule, KnowledgeModule],
  providers: [
    {
      provide: ToolRegistry,
      inject: [MediaGenerationService, ArtifactService, MemoryService, KnowledgeService],
      useFactory: (generations: MediaGenerationService, artifacts: ArtifactService, memories: MemoryService, knowledge: KnowledgeService) => {
        const registry = new ToolRegistry();
        registry.register(createImageGenerateTool(generations));
        registry.register(createVideoGenerateTool(generations));
        registry.register(createArtifactTool(artifacts));
        registry.register(createMemoryCandidateTool(memories));
        registry.register(createKnowledgeSearchTool(knowledge));
        registry.register(createExternalActionDemoTool(artifacts)); // M7-P1：审批链路入口工具
        return registry;
      },
    },
  ],
  exports: [ToolRegistry],
})
export class ToolsModule {}
