import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './modules/prisma/prisma.module';
import { CryptoModule } from './core/crypto/crypto.module';
import { AuditModule } from './modules/audit/audit.module';
import { TracingModule } from './core/tracing/tracing.module';
import { QueueDepthWorkerModule } from './worker/observability/queue-depth-worker.module';
import { BillingModule } from './modules/billing/billing.module';
import { ProvidersModule } from './providers/providers.module';
import { CircuitBreakerModule } from './core/circuit-breaker/circuit-breaker.module';
import { RouterModule } from './core/router/router.module';
import { StorageModule } from './core/storage/storage.module';
import { UsageModule } from './modules/usage/usage.module';
import { QueueModule } from './core/queue/queue.module';
import { ImageWorkerModule } from './worker/image/image-worker.module';
import { MediaCleanupWorkerModule } from './worker/media-cleanup/media-cleanup-worker.module';
import { VideoWorkerModule } from './worker/video/video-worker.module';
import { AgentRunWorkerModule } from './worker/agent-run/agent-run-worker.module';
import { WorkflowWorkerModule } from './worker/workflow/workflow-worker.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    PrismaModule, CryptoModule, AuditModule, BillingModule, ProvidersModule, CircuitBreakerModule, RouterModule,
    StorageModule, UsageModule, QueueModule,
    TracingModule, // M8-P3 可观测性（Worker 侧指标采样/审计 trace 注入）
    QueueDepthWorkerModule, // M8-P3 队列深度采样（仅 Worker 进程）
    ImageWorkerModule,
    VideoWorkerModule,
    MediaCleanupWorkerModule,
    AgentRunWorkerModule,
    WorkflowWorkerModule,
  ],
})
export class WorkerModule {}
