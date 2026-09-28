import { Module } from '@nestjs/common';
import { QueueModule } from '../../core/queue/queue.module';
import { EvaluationModule } from '../../modules/evaluation/evaluation.module';
import { EvaluationProcessor } from './evaluation.processor';

/** M9-P1 评测 Worker（processor；service/runner 复用 EvaluationModule——Worker 不引入 JWT 守卫） */
@Module({
  imports: [QueueModule, EvaluationModule],
  providers: [EvaluationProcessor],
  exports: [EvaluationProcessor],
})
export class EvaluationWorkerModule {}
