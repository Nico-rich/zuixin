import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './modules/prisma/prisma.module';
import { CryptoModule } from './core/crypto/crypto.module';
import { AuditModule } from './modules/audit/audit.module';
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
import { ExtensionsModule } from './modules/extensions/extensions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    PrismaModule, CryptoModule, AuditModule, BillingModule, ProvidersModule, CircuitBreakerModule, RouterModule,
    StorageModule, UsageModule, QueueModule,
    // M8-P6：扩展工具在 Worker 侧注册（agent run 执行时 ToolRegistry 必须含扩展工具；onModuleInit 自愈）
    ExtensionsModule,
    ImageWorkerModule,
    VideoWorkerModule,
    MediaCleanupWorkerModule,
    AgentRunWorkerModule,
    WorkflowWorkerModule,
  ],
})
export class WorkerModule {}
