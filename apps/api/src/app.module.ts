import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { PrismaModule } from './modules/prisma/prisma.module';
import { SecurityModule } from './modules/security/security.module';
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
// M13-W9 闭环断裂修复：Artifacts 只读 REST（此前只有 service 无 HTTP 面）+ 电商只读展示端点
import { ArtifactsApiModule } from './modules/artifacts/artifacts-api.module';
import { CommerceApiModule } from './modules/commerce/commerce-api.module';
import { ConnectionsApiModule } from './modules/connections/connections-api.module';
import { ExternalActionsApiModule } from './modules/external-actions/external-actions-api.module';
import { WorkflowsApiModule } from './modules/workflows/workflows-api.module';
import { FeedbackApiModule } from './modules/feedback/feedback-api.module';
import { AuditApiModule } from './modules/audit/audit-api.module';
import { OrganizationsApiModule } from './modules/organizations/organizations-api.module';
import { BillingApiModule } from './modules/billing/billing-api.module';
import { AnalyticsApiModule } from './modules/analytics/analytics-api.module';
import { ExtensionsApiModule } from './modules/extensions/extensions-api.module';
import { SchedulerApiModule } from './modules/scheduler/scheduler-api.module';
import { EventsApiModule } from './modules/events/events-api.module';
import { AuditModule } from './modules/audit/audit.module';
import { RateLimitModule } from './core/rate-limit/rate-limit.module';
import { GlobalRateLimitGuard } from './core/rate-limit/global-rate-limit.guard';
import { KnowledgeApiModule } from './modules/knowledge/knowledge.module';
import { EvaluationApiModule } from './modules/evaluation/evaluation-api.module'; // M9-P1 Evaluation
import { SystemSettingsApiModule } from './modules/system-settings/system-settings-api.module'; // M12-P4 策略设置（平台管理员面）
import { CreativeLoopApiModule } from './modules/creative-loop/creative-loop-api.module'; // M9-P5 Creative Performance Loop
import { MarketplaceApiModule } from './modules/marketplace/marketplace-api.module'; // M9-P6 Marketplace 公开层
import { TracingModule } from './core/tracing/tracing.module';
import { ObservabilityApiModule } from './modules/observability/observability-api.module';
import { GenerationsModule } from './modules/generations/generations.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { ChatModule } from './modules/chat/chat.module';
import { UsageApiModule } from './modules/usage/usage-api.module';
import { ProviderRoutingApiModule } from './modules/provider-routing/provider-routing-api.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { createHttpLoggerParams } from './common/logging/pino-logging';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { SseModule } from './core/sse/sse.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    // Pre-M9 F1：HTTP 日志脱敏（redact/serializer/深度擦洗集中在 common/logging/pino-logging.ts，与 Worker 同源）
    LoggerModule.forRoot(createHttpLoggerParams('api', {
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string) ?? randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
    })),
    PrismaModule,
    CryptoModule,
    SecurityModule, // M8-P8 安全面（SSRF 防线 / 禁用用户与会话撤销判定）
    AuditModule,
    TracingModule, // M8-P3 可观测性（TraceContext/ObservabilityService/HTTP 传播中间件）
    ObservabilityApiModule, // M8-P3 GET /metrics
    RateLimitModule,
    OrganizationsApiModule,
    BillingApiModule,
    AnalyticsApiModule,
    ExtensionsApiModule,
    SchedulerApiModule,
    EventsApiModule,
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
    ArtifactsApiModule,
    CommerceApiModule,
    ConnectionsApiModule,
    ExternalActionsApiModule,
    WorkflowsApiModule,
    FeedbackApiModule,
    AuditApiModule,
    KnowledgeApiModule,
    EvaluationApiModule, // M9-P1 Evaluation / Experimentation
    SystemSettingsApiModule, // M12-P4 策略阈值外部化（受控键白名单 + 仅平台 admin + 强制审计）
    CreativeLoopApiModule, // M9-P5 创意闭环（洞察/假设/loop 编排）
    MarketplaceApiModule, // M9-P6 Marketplace 公开层（发布/评审/审核/检索）
    GenerationsModule,
    TasksModule,
    ChatModule,
    UsageApiModule,
    ProviderRoutingApiModule,
    HealthModule,
    // Pre-M9 G3：有序优雅停机（阶段注册表）+ SSE 连接纳管（API 进程）
    LifecycleModule,
    SseModule,
  ],
  providers: [
    GlobalExceptionFilter,
    // M10-P8（SA-25）全局 per-IP 限流：本文件唯一改动者 = P8/A8。
    // 全局守卫先于控制器/路由守卫执行 → 鉴权失败（401）的请求同样计入桶（防"用无效凭证探路刷接口"）。
    // 豁免与阈值见 core/rate-limit/global-rate-limit.policy.ts（健康探针/webhook/SSE/预检不计数）。
    { provide: APP_GUARD, useClass: GlobalRateLimitGuard },
  ],
})
export class AppModule {}
