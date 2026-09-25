import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../modules/prisma/prisma.module';
import { ObservabilityService } from './observability.service';
import { TracingMiddleware } from './tracing.middleware';

/**
 * M8-P3 可观测性基础模块（@Global：API 与 Worker 两个进程图都只 import 一次）：
 * - ObservabilityService：指标采样/读取（审计模块、处理器、中间件共用）；
 * - TracingMiddleware：HTTP 传播（main.ts 单行 app.use 注册）。
 * 队列深度采样器仅在 Worker 进程挂载（worker/observability/queue-depth-worker.module.ts）。
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [ObservabilityService, TracingMiddleware],
  exports: [ObservabilityService, TracingMiddleware],
})
export class TracingModule {}
