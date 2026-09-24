-- AlterEnum
ALTER TYPE "AgentRunStatus" ADD VALUE 'waiting';

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "leaseUntil" TIMESTAMP(3),
ADD COLUMN     "retryOfRunId" TEXT,
ADD COLUMN     "waitingOnTaskId" TEXT,
ADD COLUMN     "workerId" TEXT;

-- AlterTable
ALTER TABLE "Artifact" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "ToolCall" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "AgentRunMessage" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCallId" TEXT,
    "toolCalls" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRunMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentRunMessage_runId_sequence_key" ON "AgentRunMessage"("runId", "sequence");

-- CreateIndex
CREATE INDEX "AgentRun_status_idx" ON "AgentRun"("status");

-- CreateIndex
CREATE INDEX "AgentRun_retryOfRunId_idx" ON "AgentRun"("retryOfRunId");

-- CreateIndex
CREATE INDEX "AgentRun_waitingOnTaskId_idx" ON "AgentRun"("waitingOnTaskId");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_retryOfRunId_fkey" FOREIGN KEY ("retryOfRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- M6: Artifact 幂等键部分唯一索引（Prisma schema 无法表达部分唯一约束；resume 重放去重用）
CREATE UNIQUE INDEX "Artifact_idempotencyKey_key" ON "Artifact"("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "AgentRunMessage" ADD CONSTRAINT "AgentRunMessage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
