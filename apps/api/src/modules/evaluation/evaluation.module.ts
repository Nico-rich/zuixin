import { Module } from '@nestjs/common';
import { QueueModule } from '../../core/queue/queue.module';
import { ToolsModule } from '../../core/tools/tools.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { EvaluationDatasetsService } from './datasets.service';
import { EvaluationEvaluatorsService } from './evaluators.service';
import { EvaluationRunsService } from './evaluation-runs.service';
import { ExperimentsService } from './experiments.service';
import { EvaluationRunnerService } from './runner/evaluation-runner.service';

/**
 * M9-P1 Evaluation 服务层（API 与 Worker 共用；HTTP 面在 EvaluationApiModule——Worker 不引入 JWT 守卫）。
 * ProvidersModule（LLM 抽象）/ UsageModule / EventsModule 均为 @Global，无需显式 import。
 *
 * M12-P4 新增依赖的边界说明：
 * - ToolsModule → ToolRegistry：**只在 run 创建期**把工具解析为冻结定义写进 configSnapshot
 *   （runner 不注入 ToolRegistry——结构性不可能执行工具，评测零副作用）；
 * - SystemSettingsModule → 唯一受控策略写入口（实验晋级确认复用同一白名单/审计路径）。
 */
@Module({
  imports: [QueueModule, ToolsModule, SystemSettingsModule],
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
