-- AlterEnum
BEGIN;
CREATE TYPE "DocumentSourceType_new" AS ENUM ('text', 'file');
ALTER TABLE "public"."Document" ALTER COLUMN "sourceType" DROP DEFAULT;
ALTER TABLE "Document" ALTER COLUMN "sourceType" TYPE "DocumentSourceType_new" USING ("sourceType"::text::"DocumentSourceType_new");
ALTER TYPE "DocumentSourceType" RENAME TO "DocumentSourceType_old";
ALTER TYPE "DocumentSourceType_new" RENAME TO "DocumentSourceType";
DROP TYPE "public"."DocumentSourceType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "DocumentStatus_new" AS ENUM ('pending', 'processing', 'ready', 'failed');
ALTER TABLE "public"."Document" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Document" ALTER COLUMN "status" TYPE "DocumentStatus_new" USING ("status"::text::"DocumentStatus_new");
ALTER TYPE "DocumentStatus" RENAME TO "DocumentStatus_old";
ALTER TYPE "DocumentStatus_new" RENAME TO "DocumentStatus";
DROP TYPE "public"."DocumentStatus_old";
ALTER TABLE "Document" ALTER COLUMN "status" SET DEFAULT 'pending';
COMMIT;

-- AlterEnum
ALTER TYPE "ModelType" ADD VALUE 'embedding';

-- AlterEnum
ALTER TYPE "ProviderType" ADD VALUE 'embedding';

-- DropForeignKey
ALTER TABLE "Document" DROP CONSTRAINT "Document_kbId_fkey";

-- DropIndex
DROP INDEX "Document_kbId_status_idx";

-- AlterTable
ALTER TABLE "Document" DROP COLUMN "title",
ADD COLUMN     "content" TEXT,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "projectId" TEXT,
ALTER COLUMN "kbId" DROP NOT NULL,
ALTER COLUMN "sourceType" DROP DEFAULT,
ALTER COLUMN "storageKey" DROP NOT NULL,
ALTER COLUMN "mimeType" DROP NOT NULL,
ALTER COLUMN "sizeBytes" DROP NOT NULL,
ALTER COLUMN "contentHash" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'pending';

-- AlterTable
ALTER TABLE "DocumentChunk" ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "userId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Document_userId_projectId_idx" ON "Document"("userId", "projectId");

-- CreateIndex
CREATE INDEX "Document_userId_status_idx" ON "Document"("userId", "status");

-- CreateIndex
CREATE INDEX "DocumentChunk_userId_projectId_idx" ON "DocumentChunk"("userId", "projectId");

-- CreateIndex
CREATE INDEX "DocumentChunk_documentId_idx" ON "DocumentChunk"("documentId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

