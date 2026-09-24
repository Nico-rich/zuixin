-- M6-P5: Retry 幂等（DB 层最终防线）——每个旧 run 至多一个 retry 子 run。
-- 部分唯一索引（raw SQL，与 Artifact.idempotencyKey 同法）：重复 POST retry 在并发下也只产生一行。
CREATE UNIQUE INDEX "AgentRun_retryOfRunId_key" ON "AgentRun"("retryOfRunId") WHERE "retryOfRunId" IS NOT NULL;
