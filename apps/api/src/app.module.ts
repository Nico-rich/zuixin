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
import { AgentsModule } from './agents/agents.module';
import { AgentRunsApiModule } from './modules/agent-runs/agent-runs-api.module';
import { AgentsAdminModule } from './modules/agents-admin/agents-admin.module';
import { ApprovalsApiModule } from './modules/approvals/approvals-api.module';
import { ConnectionsApiModule } from './modules/connections/connections-api.module';
import { ExternalActionsApiModule } from './modules/external-actions/external-actions-api.module';
import { WorkflowsApiModule } from './modules/workflows/workflows-api.module';
import { FeedbackApiModule } from './modules/feedback/feedback-api.module';
import { AuditApiModule } from './modules/audit/audit-api.module';
import { OrganizationsApiModule } from './modules/organizations/organizations-api.module';
import { BillingApiModule } from './modules/billing/billing-api.module';
import { AnalyticsApiModule } from './modules/analytics/analytics-api.module';
import { ExtensionsApiModule } from './modules/extensions/extensions-api.module';
import { AuditModule } from './modules/audit/audit.module';
import { RateLimitModule } from './core/rate-limit/rate-limit.module';
import { KnowledgeApiModule } from './modules/knowledge/knowledge.module';
import { TracingModule } from './core/tracing/tracing.module';
import { ObservabilityApiModule } from './modules/observability/observability-api.module';
import { GenerationsModule } from './modules/generations/generations.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { ChatModule } from './modules/chat/chat.module';
import { UsageApiModule } from './modules/usage/usage-api.module';
import { ProviderRoutingApiModule } from './modules/provider-routing/provider-routing-api.module';
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
    AuditModule,
    TracingModule, // M8-P3 可观测性（TraceContext/ObservabilityService/HTTP 传播中间件）
    ObservabilityApiModule, // M8-P3 GET /metrics
    RateLimitModule,
    OrganizationsApiModule,
    BillingApiModule,
    AnalyticsApiModule,
    ExtensionsApiModule,
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
    AgentsModule,
    AgentRunsApiModule,
    AgentsAdminModule,
    ApprovalsApiModule,
    ConnectionsApiModule,
    ExternalActionsApiModule,
    WorkflowsApiModule,
    FeedbackApiModule,
    AuditApiModule,
    KnowledgeApiModule,
    GenerationsModule,
    TasksModule,
    ChatModule,
    UsageApiModule,
    ProviderRoutingApiModule,
    HealthModule,
  ],
  providers: [GlobalExceptionFilter],
})
export class AppModule {}
