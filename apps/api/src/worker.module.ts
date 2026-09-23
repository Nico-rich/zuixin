import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './modules/prisma/prisma.module';
import { CryptoModule } from './core/crypto/crypto.module';
import { ProvidersModule } from './providers/providers.module';
import { QueueModule } from './core/queue/queue.module';
// M2/M3 在此注册 image/video 队列处理器

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    PrismaModule, CryptoModule, ProvidersModule, QueueModule,
  ],
})
export class WorkerModule {}
