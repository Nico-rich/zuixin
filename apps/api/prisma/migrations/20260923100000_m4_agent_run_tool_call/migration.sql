-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled', 'timeout');

-- CreateEnum
CREATE TYPE "AgentRunStepType" AS ENUM ('reasoning', 'tool_call', 'tool_result', 'final');

-- CreateEnum
CREATE TYPE "AgentRunStepStatus" AS ENUM ('running', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ToolCallStatus" AS ENUM ('running', 'completed', 'failed');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'builtin',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "GenerationTask" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "UsageRecord" ADD COLUMN     "runId" TEXT;

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "projectId" TEXT,
    "conversationId" TEXT,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'running',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "maxSteps" INTEGER NOT NULL DEFAULT 8,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRunStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "type" "AgentRunStepType" NOT NULL,
    "status" "AgentRunStepStatus" NOT NULL DEFAULT 'running',
    "input" JSONB,
    "output" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRunStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL,
    "runStepId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "status" "ToolCallStatus" NOT NULL DEFAULT 'running',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentRun_userId_createdAt_idx" ON "AgentRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_conversationId_idx" ON "AgentRun"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRunStep_runId_stepIndex_key" ON "AgentRunStep"("runId", "stepIndex");

-- CreateIndex
CREATE INDEX "ToolCall_toolName_startedAt_idx" ON "ToolCall"("toolName", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ToolCall_runStepId_idempotencyKey_key" ON "ToolCall"("runStepId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationTask_idempotencyKey_key" ON "GenerationTask"("idempotencyKey");

-- CreateIndex
CREATE INDEX "UsageRecord_runId_idx" ON "UsageRecord"("runId");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunStep" ADD CONSTRAINT "AgentRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCall" ADD CONSTRAINT "ToolCall_runStepId_fkey" FOREIGN KEY ("runStepId") REFERENCES "AgentRunStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

