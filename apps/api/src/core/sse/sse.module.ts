import { Global, Module } from '@nestjs/common';
import { SseRegistryService } from './sse-registry.service';

/** Pre-M9 G3：SSE 连接纳管（全局单例——SSE 端点分布在 chat / agent-runs 等多个模块） */
@Global()
@Module({ providers: [SseRegistryService], exports: [SseRegistryService] })
export class SseModule {}
