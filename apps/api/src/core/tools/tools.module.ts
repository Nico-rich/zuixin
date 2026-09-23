import { Module } from '@nestjs/common';
import { ToolRegistry } from './tool-registry.service';
import { GenerationsModule } from '../../modules/generations/generations.module';
import { ArtifactsModule } from '../../modules/artifacts/artifacts.module';
import { MemoryModule } from '../memory/memory.module';
import { MediaGenerationService } from '../../modules/generations/media-generation.service';
import { ArtifactService } from '../../modules/artifacts/artifact.service';
import { MemoryService } from '../memory/memory.service';
import { createArtifactTool, createImageGenerateTool, createMemoryCandidateTool, createVideoGenerateTool } from './builtin/tools';

@Module({
  imports: [GenerationsModule, ArtifactsModule, MemoryModule],
  providers: [
    {
      provide: ToolRegistry,
      inject: [MediaGenerationService, ArtifactService, MemoryService],
      useFactory: (generations: MediaGenerationService, artifacts: ArtifactService, memories: MemoryService) => {
        const registry = new ToolRegistry();
        registry.register(createImageGenerateTool(generations));
        registry.register(createVideoGenerateTool(generations));
        registry.register(createArtifactTool(artifacts));
        registry.register(createMemoryCandidateTool(memories));
        return registry;
      },
    },
  ],
  exports: [ToolRegistry],
})
export class ToolsModule {}
