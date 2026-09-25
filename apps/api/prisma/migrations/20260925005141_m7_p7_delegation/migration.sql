-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "delegatedByRunId" TEXT,
ADD COLUMN     "depth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "parentRunId" TEXT,
ADD COLUMN     "waitingOnDelegationId" TEXT;

-- CreateTable
CREATE TABLE "AgentDelegation" (
    "id" TEXT NOT NULL,
    "parentRunId" TEXT NOT NULL,
    "delegatedByRunId" TEXT NOT NULL,
    "childRunId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "depth" INTEGER NOT NULL DEFAULT 1,
    "resultSummary" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentDelegation_childRunId_key" ON "AgentDelegation"("childRunId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDelegation_idempotencyKey_key" ON "AgentDelegation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentDelegation_parentRunId_idx" ON "AgentDelegation"("parentRunId");

-- CreateIndex
CREATE INDEX "AgentDelegation_delegatedByRunId_idx" ON "AgentDelegation"("delegatedByRunId");

-- CreateIndex
CREATE INDEX "AgentRun_parentRunId_idx" ON "AgentRun"("parentRunId");

-- CreateIndex
CREATE INDEX "AgentRun_delegatedByRunId_idx" ON "AgentRun"("delegatedByRunId");

-- CreateIndex
CREATE INDEX "AgentRun_waitingOnDelegationId_idx" ON "AgentRun"("waitingOnDelegationId");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentDelegation" ADD CONSTRAINT "AgentDelegation_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentDelegation" ADD CONSTRAINT "AgentDelegation_childRunId_fkey" FOREIGN KEY ("childRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
