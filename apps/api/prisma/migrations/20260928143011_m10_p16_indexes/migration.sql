-- DropIndex
DROP INDEX "Conversation_userId_updatedAt_idx";

-- DropIndex
DROP INDEX "Message_conversationId_createdAt_idx";

-- CreateIndex
CREATE INDEX "Conversation_userId_deletedAt_updatedAt_id_idx" ON "Conversation"("userId", "deletedAt", "updatedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "EvaluationResult_evaluatorId_idx" ON "EvaluationResult"("evaluatorId");

-- CreateIndex
CREATE INDEX "ExtensionPublication_status_createdAt_id_idx" ON "ExtensionPublication"("status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "GenerationTask_conversationId_createdAt_idx" ON "GenerationTask"("conversationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MemoryCandidate_sourceSummaryId_idx" ON "MemoryCandidate"("sourceSummaryId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_id_idx" ON "Message"("conversationId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "UsageRecord_providerId_createdAt_idx" ON "UsageRecord"("providerId", "createdAt");


-- ===== M10-P16：Prisma 不可表达索引（表达式/部分索引）——手写幂等段；后续 migrate diff 的孤儿判定
-- 由下方守卫注释约定（create-only 后必查 DROP INDEX，此处索引绝不 DROP）=====
-- MetricSample 最大表 + JSONB 路径谓词（实测最差查询 4.83ms/扫 11.5k 行）
CREATE INDEX IF NOT EXISTS "MetricSample_labelsUserId_idx" ON "MetricSample" ((labels->>'userId'), "sampledAt" DESC);
-- AgentRun 活跃计数部分索引（配额断言每请求执行；status 前缀选择性差）
CREATE INDEX IF NOT EXISTS "AgentRun_projectId_active_idx" ON "AgentRun"("projectId") WHERE status IN ('queued','running','waiting');
CREATE INDEX IF NOT EXISTS "AgentRun_userId_active_idx" ON "AgentRun"("userId") WHERE status IN ('queued','running','waiting');
