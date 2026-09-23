import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './modules/prisma/prisma.module';
import { CryptoModule } from './core/crypto/crypto.module';
import { ProvidersModule } from './providers/providers.module';
import { CircuitBreakerModule } from './core/circuit-breaker/circuit-breaker.module';
import { RouterModule } from './core/router/router.module';
import { StorageModule } from './core/storage/storage.module';
import { UsageModule } from './modules/usage/usage.module';
import { QueueModule } from './core/queue/queue.module';
import { ImageWorkerModule } from './worker/image/image-worker.module';
import { MediaCleanupWorkerModule } from './worker/media-cleanup/media-cleanup-worker.module';
// M3 在此注册 video 队列处理器

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    PrismaModule, CryptoModule, ProvidersModule, CircuitBreakerModule, RouterModule,
    StorageModule, UsageModule, QueueModule,
    ImageWorkerModule,
    MediaCleanupWorkerModule,
  ],
})
export class WorkerModule {}
