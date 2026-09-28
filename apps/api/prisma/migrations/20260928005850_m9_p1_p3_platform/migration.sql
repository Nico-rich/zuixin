-- DropIndex
DROP INDEX "ConversationSummary_conversationId_key";

-- DropIndex
DROP INDEX "DocumentChunk_embedding_hnsw_idx";

-- AlterTable
ALTER TABLE "ConversationSummary" ADD COLUMN     "parentSummaryId" TEXT,
ADD COLUMN     "sourceEndMessageId" TEXT,
ADD COLUMN     "sourceStartMessageId" TEXT,
ADD COLUMN     "stale" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tokenCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "EvaluationDataset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvaluationDataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationCase" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "input" JSONB NOT NULL,
    "expected" JSONB,
    "tags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "datasetVersion" INTEGER NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentVersionId" TEXT NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalCases" INTEGER NOT NULL DEFAULT 0,
    "completedCases" INTEGER NOT NULL DEFAULT 0,
    "baselineRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationCaseRun" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "latencyMs" INTEGER,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "toolCalls" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EvaluationCaseRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evaluator" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Evaluator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationResult" (
    "id" TEXT NOT NULL,
    "caseRunId" TEXT NOT NULL,
    "evaluatorId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "hypothesis" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentVariant" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agentId" TEXT,
    "agentVersionId" TEXT,
    "configSnapshot" JSONB NOT NULL,
    "isBaseline" BOOLEAN NOT NULL DEFAULT false,
    "trafficPercent" INTEGER NOT NULL DEFAULT 0,
    "metrics" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExperimentVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryCandidate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "sourceSummaryId" TEXT,
    "content" TEXT NOT NULL,
    "category" "MemoryCategory" NOT NULL,
    "importance" INTEGER NOT NULL DEFAULT 50,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvaluationDataset_organizationId_idx" ON "EvaluationDataset"("organizationId");

-- CreateIndex
CREATE INDEX "EvaluationCase_datasetId_version_idx" ON "EvaluationCase"("datasetId", "version");

-- CreateIndex
CREATE INDEX "EvaluationRun_organizationId_createdAt_idx" ON "EvaluationRun"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "EvaluationCaseRun_runId_idx" ON "EvaluationCaseRun"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationCaseRun_runId_caseId_key" ON "EvaluationCaseRun"("runId", "caseId");

-- CreateIndex
CREATE INDEX "Evaluator_organizationId_idx" ON "Evaluator"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationResult_caseRunId_evaluatorId_key" ON "EvaluationResult"("caseRunId", "evaluatorId");

-- CreateIndex
CREATE INDEX "Experiment_organizationId_idx" ON "Experiment"("organizationId");

-- CreateIndex
CREATE INDEX "MemoryCandidate_userId_status_idx" ON "MemoryCandidate"("userId", "status");

-- CreateIndex
CREATE INDEX "ConversationSummary_conversationId_createdAt_idx" ON "ConversationSummary"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "ConversationSummary" ADD CONSTRAINT "ConversationSummary_parentSummaryId_fkey" FOREIGN KEY ("parentSummaryId") REFERENCES "ConversationSummary"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationDataset" ADD CONSTRAINT "EvaluationDataset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationDataset" ADD CONSTRAINT "EvaluationDataset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationCase" ADD CONSTRAINT "EvaluationCase_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "EvaluationDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "EvaluationDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationCaseRun" ADD CONSTRAINT "EvaluationCaseRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvaluationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluator" ADD CONSTRAINT "Evaluator_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluator" ADD CONSTRAINT "Evaluator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_caseRunId_fkey" FOREIGN KEY ("caseRunId") REFERENCES "EvaluationCaseRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_evaluatorId_fkey" FOREIGN KEY ("evaluatorId") REFERENCES "Evaluator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentVariant" ADD CONSTRAINT "ExperimentVariant_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
