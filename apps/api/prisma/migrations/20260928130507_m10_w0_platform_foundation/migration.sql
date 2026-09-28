-- M10 W0: 自声明依赖（sha256 回填用）；fresh DB 重放必备
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "CreativeHypothesisStatus" AS ENUM ('draft', 'ready', 'running', 'validated', 'rejected');

-- NOTE(M10 W0): migrate diff 对 Unsupported 列(vector)上的 HNSW 自定义索引存在孤儿判定
-- （Prisma 第四次出现）——绝不生成 DROP INDEX；下方手工保留既有索引不动。

-- AlterTable
ALTER TABLE "Credential" ADD COLUMN     "keyVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
-- M10-P11: 先以可空列加入 → sha256 回填（pgcrypto 已由 M10 W0 创建）→ 同用户同内容去重（保留最早）→ 收紧 NOT NULL → 建唯一索引
ALTER TABLE "MemoryCandidate" ADD COLUMN     "contentHash" TEXT;

-- Backfill: content 的 sha256 指纹（pgcrypto digest；绝不含用户可注入的解释层）
UPDATE "MemoryCandidate" SET "contentHash" = encode(digest("content", 'sha256'), 'hex');

-- Dedupe: 同用户同内容保留最早一行（id 升序 = 先创建者胜）
DELETE FROM "MemoryCandidate" a
USING "MemoryCandidate" b
WHERE a."userId" = b."userId"
  AND a."contentHash" = b."contentHash"
  AND a.id > b.id;

ALTER TABLE "MemoryCandidate" ALTER COLUMN "contentHash" SET NOT NULL;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "editedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "status" "OrganizationStatus" NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN     "definitionSnapshot" JSONB;

-- CreateTable
CREATE TABLE "CreativeHypothesis" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "userId" TEXT NOT NULL,
    "status" "CreativeHypothesisStatus" NOT NULL DEFAULT 'draft',
    "statement" TEXT NOT NULL,
    "rationale" TEXT,
    "target" TEXT,
    "platform" TEXT,
    "insightId" TEXT,
    "successCriteria" JSONB,
    "loop" JSONB,
    "evaluationRunId" TEXT,
    "baselineRunId" TEXT,
    "experimentId" TEXT,
    "verdict" JSONB,
    "history" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeHypothesis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeInsight" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "userId" TEXT NOT NULL,
    "window" JSONB NOT NULL,
    "filters" JSONB NOT NULL,
    "facts" JSONB NOT NULL,
    "derived" JSONB NOT NULL,
    "factsHash" TEXT NOT NULL,
    "interpretation" JSONB,
    "layering" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionOrgAllowlist" (
    "id" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtensionOrgAllowlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreativeHypothesis_organizationId_status_idx" ON "CreativeHypothesis"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CreativeHypothesis_projectId_idx" ON "CreativeHypothesis"("projectId");

-- CreateIndex
CREATE INDEX "CreativeHypothesis_organizationId_createdAt_idx" ON "CreativeHypothesis"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeInsight_organizationId_createdAt_idx" ON "CreativeInsight"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeInsight_organizationId_factsHash_idx" ON "CreativeInsight"("organizationId", "factsHash");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionOrgAllowlist_extensionId_organizationId_key" ON "ExtensionOrgAllowlist"("extensionId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryCandidate_userId_contentHash_key" ON "MemoryCandidate"("userId", "contentHash");

-- AddForeignKey
ALTER TABLE "CreativeHypothesis" ADD CONSTRAINT "CreativeHypothesis_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeHypothesis" ADD CONSTRAINT "CreativeHypothesis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeHypothesis" ADD CONSTRAINT "CreativeHypothesis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeInsight" ADD CONSTRAINT "CreativeInsight_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeInsight" ADD CONSTRAINT "CreativeInsight_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeInsight" ADD CONSTRAINT "CreativeInsight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionOrgAllowlist" ADD CONSTRAINT "ExtensionOrgAllowlist_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionOrgAllowlist" ADD CONSTRAINT "ExtensionOrgAllowlist_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

