import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { PrismaModule } from './modules/prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { CryptoModule } from './core/crypto/crypto.module';
import { StorageModule } from './core/storage/storage.module';
import { QueueModule } from './core/queue/queue.module';
import { CircuitBreakerModule } from './core/circuit-breaker/circuit-breaker.module';
import { RouterModule } from './core/router/router.module';
import { ProvidersModule } from './providers/providers.module';
import { AuthModule } from './modules/auth/auth.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { MemoriesModule } from './modules/memories/memories.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { ChatModule } from './modules/chat/chat.module';
import { UsageModule } from './modules/usage/usage.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
        genReqId: (req, res) => {
          const id = (req.headers['x-request-id'] as string) ?? randomUUID();
          res.setHeader('X-Request-Id', id);
          return id;
        },
        redact: ['req.headers.authorization', 'req.headers.cookie', 'apiKey'],
        autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
      },
    }),
    PrismaModule,
    CryptoModule,
    StorageModule,
    QueueModule,
    CircuitBreakerModule,
    RouterModule,
    ProvidersModule,
    AuthModule,
    ConversationsModule,
    ProjectsModule,
    MemoriesModule,
    AttachmentsModule,
    ChatModule,
    UsageModule,
    HealthModule,
  ],
  providers: [GlobalExceptionFilter],
})
export class AppModule {}
