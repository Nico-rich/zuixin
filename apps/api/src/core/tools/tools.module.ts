import { Module } from '@nestjs/common';
import { ToolRegistry } from './tool-registry.service';
import { GenerationsModule } from '../../modules/generations/generations.module';
import { ArtifactsModule } from '../../modules/artifacts/artifacts.module';
import { MemoryModule } from '../memory/memory.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ExternalActionsModule } from '../../modules/external-actions/external-actions.module';
import { MediaGenerationService } from '../../modules/generations/media-generation.service';
import { ArtifactService } from '../../modules/artifacts/artifact.service';
import { MemoryService } from '../memory/memory.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ExternalActionsService } from '../../modules/external-actions/external-actions.service';
import { createArtifactTool, createImageGenerateTool, createMemoryCandidateTool, createVideoGenerateTool } from './builtin/tools';
import { createKnowledgeSearchTool } from './builtin/knowledge.tool';
import { createExternalActionDemoTool } from './builtin/approval.tool';
import { createExternalActionExecuteTool } from './builtin/external-action.tool';

@Module({
  imports: [GenerationsModule, ArtifactsModule, MemoryModule, KnowledgeModule, ExternalActionsModule],
  providers: [
    {
      provide: ToolRegistry,
      inject: [MediaGenerationService, ArtifactService, MemoryService, KnowledgeService, ExternalActionsService],
      useFactory: (generations: MediaGenerationService, artifacts: ArtifactService, memories: MemoryService, knowledge: KnowledgeService, actions: ExternalActionsService) => {
        const registry = new ToolRegistry();
        registry.register(createImageGenerateTool(generations));
        registry.register(createVideoGenerateTool(generations));
        registry.register(createArtifactTool(artifacts));
        registry.register(createMemoryCandidateTool(memories));
        registry.register(createKnowledgeSearchTool(knowledge));
        registry.register(createExternalActionDemoTool(artifacts)); // M7-P1：审批链路入口工具
        registry.register(createExternalActionExecuteTool(actions)); // M7-P3：外部副作用统一入口
        return registry;
      },
    },
  ],
  exports: [ToolRegistry],
})
export class ToolsModule {}
