-- DropIndex
DROP INDEX "DocumentChunk_embedding_hnsw_idx";

-- CreateIndex
CREATE INDEX "GenerationTask_messageId_idx" ON "GenerationTask"("messageId");

