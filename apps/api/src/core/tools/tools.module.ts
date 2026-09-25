import { Module } from '@nestjs/common';
import { ToolRegistry } from './tool-registry.service';
import { GenerationsModule } from '../../modules/generations/generations.module';
import { ArtifactsModule } from '../../modules/artifacts/artifacts.module';
import { MemoryModule } from '../memory/memory.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ExternalActionsModule } from '../../modules/external-actions/external-actions.module';
import { CommerceModule } from '../../modules/commerce/commerce.module';
import { AgentDelegationModule } from '../../modules/agent-delegation/agent-delegation.module';
import { FeedbackModule } from '../../modules/feedback/feedback.module';
import { FeedbackService } from '../../modules/feedback/feedback.service';
import { MediaGenerationService } from '../../modules/generations/media-generation.service';
import { ArtifactService } from '../../modules/artifacts/artifact.service';
import { MemoryService } from '../memory/memory.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ExternalActionsService } from '../../modules/external-actions/external-actions.service';
import { CommerceService } from '../../modules/commerce/commerce.service';
import { CommerceAnalysisService } from '../../modules/commerce/commerce-analysis.service';
import { DelegationService } from '../../modules/agent-delegation/delegation.service';
import { createArtifactTool, createImageGenerateTool, createMemoryCandidateTool, createVideoGenerateTool } from './builtin/tools';
import { createKnowledgeSearchTool } from './builtin/knowledge.tool';
import { createExternalActionDemoTool } from './builtin/approval.tool';
import { createExternalActionExecuteTool } from './builtin/external-action.tool';
import { createCommerceTools } from './builtin/commerce.tools';
import { createAnalysisTools } from './builtin/analysis.tools';
import { createDelegateTool } from './builtin/delegation.tool';
import { createFeedbackTools } from './builtin/feedback.tools';

@Module({
  imports: [GenerationsModule, ArtifactsModule, MemoryModule, KnowledgeModule, ExternalActionsModule, CommerceModule, AgentDelegationModule, FeedbackModule],
  providers: [
    {
      provide: ToolRegistry,
      inject: [MediaGenerationService, ArtifactService, MemoryService, KnowledgeService, ExternalActionsService, CommerceService, CommerceAnalysisService, DelegationService, FeedbackService],
      useFactory: (generations: MediaGenerationService, artifacts: ArtifactService, memories: MemoryService, knowledge: KnowledgeService, actions: ExternalActionsService, commerce: CommerceService, analysis: CommerceAnalysisService, delegation: DelegationService, feedback: FeedbackService) => {
        const registry = new ToolRegistry();
        registry.register(createImageGenerateTool(generations));
        registry.register(createVideoGenerateTool(generations));
        registry.register(createArtifactTool(artifacts));
        registry.register(createMemoryCandidateTool(memories));
        registry.register(createKnowledgeSearchTool(knowledge));
        registry.register(createExternalActionDemoTool(artifacts)); // M7-P1：审批链路入口工具
        registry.register(createExternalActionExecuteTool(actions)); // M7-P3：外部副作用统一入口
        for (const t of createCommerceTools(commerce)) registry.register(t); // M7-P4：只读电商数据工具集
        for (const t of createAnalysisTools(analysis)) registry.register(t); // M7-P5：分析 + 创意简报
        registry.register(createDelegateTool(delegation)); // M7-P7：安全委派
        for (const t of createFeedbackTools(feedback)) registry.register(t); // M7-P8：反馈/绩效学习闭环
        return registry;
      },
    },
  ],
  exports: [ToolRegistry],
})
export class ToolsModule {}
