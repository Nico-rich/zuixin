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
import { SchedulerWorkerModule } from './worker/scheduler/scheduler-worker.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    PrismaModule, CryptoModule, AuditModule, BillingModule, ProvidersModule, CircuitBreakerModule, RouterModule,
    StorageModule, UsageModule, QueueModule,
    ImageWorkerModule,
    VideoWorkerModule,
    MediaCleanupWorkerModule,
    AgentRunWorkerModule,
    WorkflowWorkerModule,
    SchedulerWorkerModule,
  ],
})
export class WorkerModule {}
