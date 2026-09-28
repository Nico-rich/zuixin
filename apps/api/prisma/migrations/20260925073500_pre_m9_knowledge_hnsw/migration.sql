-- Pre-M9 P4：知识检索向量 ANN 索引（HNSW + cosine；pgvector/pg16）
-- 前提：平台固定嵌入维度 1536（MOCK_EMBEDDING_DIMS/真实 adapter 同维度——混合维度无法建索引）。
-- 检索查询改写为 ORDER BY embedding <=> query 后走本索引；
-- 过滤条件（userId/projectId）由 HNSW 候选集后过滤（相似度阈值 + scope 校验在 SQL 层，绝不信任调用方）。
ALTER TABLE "DocumentChunk" ALTER COLUMN embedding TYPE vector(1536) USING embedding::vector(1536);
CREATE INDEX "DocumentChunk_embedding_hnsw_idx" ON "DocumentChunk" USING hnsw (embedding vector_cosine_ops);
