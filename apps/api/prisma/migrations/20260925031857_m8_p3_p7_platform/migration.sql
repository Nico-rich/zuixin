-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorId" TEXT,
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "result" TEXT,
ADD COLUMN     "traceId" TEXT;

-- CreateTable
CREATE TABLE "MetricSample" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'count',
    "labels" JSONB,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsAggregate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "dimensions" JSONB,
    "metrics" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsAggregate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledJob" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'one-shot',
    "cron" TEXT,
    "runAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "timeoutMs" INTEGER NOT NULL DEFAULT 60000,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "backoffMs" INTEGER NOT NULL DEFAULT 2000,
    "payload" JSONB,
    "handler" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "traceId" TEXT,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventEnvelope" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "organizationId" TEXT,
    "projectId" TEXT,
    "actorId" TEXT,
    "aggregateType" TEXT,
    "aggregateId" TEXT,
    "payload" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "traceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'published',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventEnvelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Extension" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Extension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionVersion" (
    "id" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "signature" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtensionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionPermission" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'organization',
    "description" TEXT,

    CONSTRAINT "ExtensionPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionInstallation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'enabled',
    "config" JSONB,
    "installedByUserId" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtensionInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCapability" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "modelIds" JSONB,
    "contextWindow" INTEGER,
    "features" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCapability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "providerId" TEXT NOT NULL,
    "allow" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "costCeilingPerRequest" DOUBLE PRECISION,
    "costCeilingMonthly" DOUBLE PRECISION,
    "dataPolicy" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingDecision" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "requestId" TEXT,
    "traceId" TEXT,
    "runId" TEXT,
    "taskId" TEXT,
    "capability" TEXT NOT NULL,
    "providerId" TEXT,
    "candidates" JSONB NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "policyId" TEXT,
    "estimatedCost" DOUBLE PRECISION,
    "actualCost" DOUBLE PRECISION,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutingDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetricSample_name_sampledAt_idx" ON "MetricSample"("name", "sampledAt");

-- CreateIndex
CREATE INDEX "MetricSample_organizationId_sampledAt_idx" ON "MetricSample"("organizationId", "sampledAt");

-- CreateIndex
CREATE INDEX "AnalyticsAggregate_organizationId_period_idx" ON "AnalyticsAggregate"("organizationId", "period");

-- CreateIndex
CREATE INDEX "AnalyticsAggregate_kind_period_idx" ON "AnalyticsAggregate"("kind", "period");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsAggregate_organizationId_userId_kind_period_source_key" ON "AnalyticsAggregate"("organizationId", "userId", "kind", "period", "source");

-- CreateIndex
CREATE INDEX "ScheduledJob_organizationId_status_idx" ON "ScheduledJob"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ScheduledJob_runAt_idx" ON "ScheduledJob"("runAt");

-- CreateIndex
CREATE INDEX "ScheduledJob_status_runAt_idx" ON "ScheduledJob"("status", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledJob_idempotencyKey_key" ON "ScheduledJob"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "EventEnvelope_eventId_key" ON "EventEnvelope"("eventId");

-- CreateIndex
CREATE INDEX "EventEnvelope_eventType_occurredAt_idx" ON "EventEnvelope"("eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "EventEnvelope_organizationId_occurredAt_idx" ON "EventEnvelope"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "EventEnvelope_aggregateType_aggregateId_idx" ON "EventEnvelope"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "EventEnvelope_status_occurredAt_idx" ON "EventEnvelope"("status", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Extension_slug_key" ON "Extension"("slug");

-- CreateIndex
CREATE INDEX "Extension_organizationId_status_idx" ON "Extension"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionVersion_extensionId_version_key" ON "ExtensionVersion"("extensionId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionPermission_versionId_name_key" ON "ExtensionPermission"("versionId", "name");

-- CreateIndex
CREATE INDEX "ExtensionInstallation_organizationId_status_idx" ON "ExtensionInstallation"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionInstallation_organizationId_extensionId_key" ON "ExtensionInstallation"("organizationId", "extensionId");

-- CreateIndex
CREATE INDEX "ProviderCapability_capability_idx" ON "ProviderCapability"("capability");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCapability_providerId_capability_key" ON "ProviderCapability"("providerId", "capability");

-- CreateIndex
CREATE INDEX "ProviderPolicy_organizationId_enabled_idx" ON "ProviderPolicy"("organizationId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderPolicy_organizationId_providerId_key" ON "ProviderPolicy"("organizationId", "providerId");

-- CreateIndex
CREATE INDEX "RoutingDecision_organizationId_decidedAt_idx" ON "RoutingDecision"("organizationId", "decidedAt");

-- CreateIndex
CREATE INDEX "RoutingDecision_runId_idx" ON "RoutingDecision"("runId");

-- CreateIndex
CREATE INDEX "RoutingDecision_providerId_decidedAt_idx" ON "RoutingDecision"("providerId", "decidedAt");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_traceId_idx" ON "AuditLog"("traceId");

-- AddForeignKey
ALTER TABLE "MetricSample" ADD CONSTRAINT "MetricSample_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsAggregate" ADD CONSTRAINT "AnalyticsAggregate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledJob" ADD CONSTRAINT "ScheduledJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledJob" ADD CONSTRAINT "ScheduledJob_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventEnvelope" ADD CONSTRAINT "EventEnvelope_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extension" ADD CONSTRAINT "Extension_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extension" ADD CONSTRAINT "Extension_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionVersion" ADD CONSTRAINT "ExtensionVersion_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionPermission" ADD CONSTRAINT "ExtensionPermission_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ExtensionVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionInstallation" ADD CONSTRAINT "ExtensionInstallation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderPolicy" ADD CONSTRAINT "ProviderPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingDecision" ADD CONSTRAINT "RoutingDecision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
