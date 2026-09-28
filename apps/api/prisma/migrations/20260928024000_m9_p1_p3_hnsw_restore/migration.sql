-- M9-P3 接线自验发现（Coordinator 预整合失误的恢复）：m9_p1_p3_platform 迁移生成的
-- DROP INDEX "DocumentChunk_embedding_hnsw_idx" 已随 deploy 应用——Prisma 无法表达
-- Unsupported 列上的自定义索引，migrate diff 将其视为孤儿删除。
-- 本迁移恢复该索引（Pre-M9 P4 向量检索依赖；与 pre_m9_knowledge_hnsw 同定义）。
CREATE INDEX "DocumentChunk_embedding_hnsw_idx" ON "DocumentChunk" USING hnsw (embedding vector_cosine_ops);
