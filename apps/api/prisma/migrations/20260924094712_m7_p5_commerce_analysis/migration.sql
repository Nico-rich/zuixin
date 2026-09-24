-- CreateTable
CREATE TABLE "CommerceAnalysis" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "agentRunId" TEXT,
    "connectionId" TEXT,
    "analysisType" TEXT NOT NULL,
    "timeRange" JSONB NOT NULL,
    "facts" JSONB NOT NULL,
    "derived" JSONB NOT NULL,
    "anomalies" JSONB,
    "possibleCauses" JSONB,
    "recommendations" JSONB,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeBrief" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "agentRunId" TEXT,
    "commerceAnalysisId" TEXT,
    "problem" TEXT NOT NULL,
    "target" TEXT,
    "objective" TEXT NOT NULL,
    "creativeAngle" TEXT,
    "visualDirection" TEXT,
    "copyDirection" TEXT,
    "constraints" JSONB,
    "platform" TEXT,
    "product" JSONB,
    "evidence" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "artifactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeBrief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommerceAnalysis_userId_createdAt_idx" ON "CommerceAnalysis"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceAnalysis_agentRunId_idx" ON "CommerceAnalysis"("agentRunId");

-- CreateIndex
CREATE INDEX "CreativeBrief_userId_createdAt_idx" ON "CreativeBrief"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeBrief_agentRunId_idx" ON "CreativeBrief"("agentRunId");

-- CreateIndex
CREATE INDEX "CreativeBrief_commerceAnalysisId_idx" ON "CreativeBrief"("commerceAnalysisId");

-- AddForeignKey
ALTER TABLE "CommerceAnalysis" ADD CONSTRAINT "CommerceAnalysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceAnalysis" ADD CONSTRAINT "CommerceAnalysis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceAnalysis" ADD CONSTRAINT "CommerceAnalysis_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeBrief" ADD CONSTRAINT "CreativeBrief_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeBrief" ADD CONSTRAINT "CreativeBrief_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeBrief" ADD CONSTRAINT "CreativeBrief_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeBrief" ADD CONSTRAINT "CreativeBrief_commerceAnalysisId_fkey" FOREIGN KEY ("commerceAnalysisId") REFERENCES "CommerceAnalysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;
