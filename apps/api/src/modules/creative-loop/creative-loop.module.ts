import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { EvaluationModule } from '../evaluation/evaluation.module';
import { CreativeLoopAccessService } from './creative-loop-access.service';
import { HypothesisStore, InsightStore } from './creative-loop-store';
import { HypothesesService } from './hypotheses.service';
import { InsightService } from './insight.service';
import { CreativeLoopOrchestrator } from './loop-orchestrator.service';

/**
 * M9-P5 Creative Performance Loop 服务层（API 与 Worker 共用；HTTP 面在 CreativeLoopApiModule）。
 *
 * 复用（绝不重复实现）：WorkflowsModule（M7-P6 引擎 + M9-P4 wait/approval/compensation）、
 * EvaluationModule（M9-P1 评测/实验）、OrganizationsModule（RBAC）。
 * PrismaModule 为 @Global，无需显式 import。
 */
@Module({
  imports: [OrganizationsModule, WorkflowsModule, EvaluationModule],
  providers: [
    CreativeLoopAccessService,
    HypothesisStore,
    InsightStore,
    HypothesesService,
    InsightService,
    CreativeLoopOrchestrator,
  ],
  exports: [
    CreativeLoopAccessService,
    HypothesisStore,
    InsightStore,
    HypothesesService,
    InsightService,
    CreativeLoopOrchestrator,
  ],
})
export class CreativeLoopModule {}
