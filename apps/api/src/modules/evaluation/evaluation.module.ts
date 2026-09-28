import { Module } from '@nestjs/common';
import { QueueModule } from '../../core/queue/queue.module';
import { EvaluationDatasetsService } from './datasets.service';
import { EvaluationEvaluatorsService } from './evaluators.service';
import { EvaluationRunsService } from './evaluation-runs.service';
import { ExperimentsService } from './experiments.service';
import { EvaluationRunnerService } from './runner/evaluation-runner.service';

/**
 * M9-P1 Evaluation 服务层（API 与 Worker 共用；HTTP 面在 EvaluationApiModule——Worker 不引入 JWT 守卫）。
 * ProvidersModule（LLM 抽象）/ UsageModule / EventsModule 均为 @Global，无需显式 import。
 */
@Module({
  imports: [QueueModule],
  providers: [
    EvaluationDatasetsService,
    EvaluationEvaluatorsService,
    EvaluationRunsService,
    ExperimentsService,
    EvaluationRunnerService,
  ],
  exports: [
    EvaluationDatasetsService,
    EvaluationEvaluatorsService,
    EvaluationRunsService,
    ExperimentsService,
    EvaluationRunnerService,
  ],
})
export class EvaluationModule {}
