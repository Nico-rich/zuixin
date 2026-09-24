-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('requested', 'approved', 'rejected', 'expired', 'cancelled');

-- AlterEnum
ALTER TYPE "ToolCallStatus" ADD VALUE 'waiting_approval';

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "waitingOnApprovalId" TEXT;

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "agentRunId" TEXT,
    "toolCallId" TEXT,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'requested',
    "riskLevel" TEXT NOT NULL DEFAULT 'medium',
    "reason" TEXT NOT NULL,
    "payload" JSONB,
    "expiresAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Approval_userId_createdAt_idx" ON "Approval"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Approval_projectId_idx" ON "Approval"("projectId");

-- CreateIndex
CREATE INDEX "Approval_agentRunId_idx" ON "Approval"("agentRunId");

-- CreateIndex
CREATE INDEX "Approval_toolCallId_idx" ON "Approval"("toolCallId");

-- CreateIndex
CREATE INDEX "Approval_status_expiresAt_idx" ON "Approval"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "AgentRun_waitingOnApprovalId_idx" ON "AgentRun"("waitingOnApprovalId");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_waitingOnApprovalId_fkey" FOREIGN KEY ("waitingOnApprovalId") REFERENCES "Approval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_toolCallId_fkey" FOREIGN KEY ("toolCallId") REFERENCES "ToolCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;
