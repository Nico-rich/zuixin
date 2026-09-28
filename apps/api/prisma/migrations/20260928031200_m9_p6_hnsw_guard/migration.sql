-- M9-P6 schema 整合收尾：HNSW 索引守卫（幂等 IF NOT EXISTS）。
-- 背景：m9_p6_marketplace 迁移生成时 Prisma 把 Unsupported 列上的 HNSW 索引判为孤儿并生成 DROP INDEX；
-- 该行已从文件中剔除（迁移未动簿记表），真实库在整合过程中索引曾两度被 drop/恢复。
-- 本迁移保证任意重放顺序（真实库 / fresh 链）最终都持有该索引——P4 检索 EXPLAIN 依赖。
CREATE INDEX IF NOT EXISTS "DocumentChunk_embedding_hnsw_idx" ON "DocumentChunk" USING hnsw (embedding vector_cosine_ops);
