-- M10 Final Audit：恢复上一迁移（m10_final_audit_messageid_index）被 migrate diff 误生成的
-- DROP INDEX 所删除的 HNSW 索引——Prisma 对 Unsupported 列（vector）上自定义索引的孤儿判定
-- （**第 6 次出现**）。教训再固化：create-only/diff 后必须人工检查 DROP INDEX 行再 deploy。
-- 本次 Coordinator 失守纪律直接 deploy，故以恢复迁移补救（已应用迁移绝不改写）。
CREATE INDEX IF NOT EXISTS "DocumentChunk_embedding_hnsw_idx" ON "DocumentChunk" USING hnsw ("embedding" vector_cosine_ops);
