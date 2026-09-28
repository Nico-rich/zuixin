-- M10 Final Audit H7：P16 交付的表达式索引与 Prisma 实际 emit 的谓词不同形
-- （索引 ((labels->>'userId'))，Prisma emit `labels#>ARRAY['userId']::text[]`）→ 实测仍 Seq Scan。
-- 修正为与唯一消费者 observability.service.ts:131 完全同形的表达式。
-- 注：schema.prisma 无法表达表达式索引（Prisma 不支持）——本索引为手工维护段；
-- 后续 migrate diff 的孤儿判定对非 Unsupported 列表达式索引同样可能生成 DROP（create-only 后必查）。
DROP INDEX IF EXISTS "MetricSample_labelsUserId_idx";
CREATE INDEX "MetricSample_labelsUserId_idx" ON "MetricSample" (((labels #> ARRAY['userId']::text[])), "sampledAt" DESC);
