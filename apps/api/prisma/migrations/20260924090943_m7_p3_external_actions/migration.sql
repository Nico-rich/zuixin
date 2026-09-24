-- CreateEnum
CREATE TYPE "ExternalActionStatus" AS ENUM ('pending_approval', 'executing', 'completed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "ExternalAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "agentRunId" TEXT,
    "toolCallId" TEXT,
    "approvalId" TEXT,
    "connectionId" TEXT,
    "provider" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "status" "ExternalActionStatus" NOT NULL DEFAULT 'pending_approval',
    "externalRequestId" TEXT,
    "result" JSONB,
    "errorCode" TEXT,
    "error" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalAction_userId_createdAt_idx" ON "ExternalAction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ExternalAction_agentRunId_idx" ON "ExternalAction"("agentRunId");

-- CreateIndex
CREATE INDEX "ExternalAction_approvalId_idx" ON "ExternalAction"("approvalId");

-- CreateIndex
CREATE INDEX "ExternalAction_toolCallId_idx" ON "ExternalAction"("toolCallId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalAction_userId_provider_idempotencyKey_key" ON "ExternalAction"("userId", "provider", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ExternalAction" ADD CONSTRAINT "ExternalAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAction" ADD CONSTRAINT "ExternalAction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAction" ADD CONSTRAINT "ExternalAction_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAction" ADD CONSTRAINT "ExternalAction_toolCallId_fkey" FOREIGN KEY ("toolCallId") REFERENCES "ToolCall"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAction" ADD CONSTRAINT "ExternalAction_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAction" ADD CONSTRAINT "ExternalAction_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
