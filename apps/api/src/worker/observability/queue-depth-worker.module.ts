import { Module } from '@nestjs/common';
import { QueueDepthSampler } from '../../core/tracing/queue-depth.sampler';

/** M8-P3 队列深度采样（仅 Worker 进程挂载；ObservabilityService 由 @Global TracingModule 提供） */
@Module({
  providers: [QueueDepthSampler],
  exports: [QueueDepthSampler],
})
export class QueueDepthWorkerModule {}
