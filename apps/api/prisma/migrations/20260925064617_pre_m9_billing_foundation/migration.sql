/*
  Pre-M9 计费正确性基础迁移（Coordinator 单点；工作树 Agent 绝不修改 schema/migration）

  1. T1：UsageRecord.organizationId NOT NULL——写入时从 run/project/user 事实链解析（事实不可无主）；
     历史回填链：run→项目组织 > task→run→项目组织 > conversation→项目组织 > message→conversation→项目组织
     > 用户个人组织；显式兜底 legacy-unattributed（不允许 silently null；断言保证零 NULL）。
  2. S1：AnalyticsAggregate 组织/用户列 NOT NULL——'global' 显式哨兵替代 NULL 隐式全局
     （NULL-distinct 使唯一约束失效、并发刷新双写）。
  3. P6 索引：quota 日聚合 / Project.organizationId / lease 清扫复合索引。
*/

-- ===== S1 前置：AnalyticsAggregate NULL → 'global' 哨兵 =====
UPDATE "AnalyticsAggregate" SET "organizationId" = 'global' WHERE "organizationId" IS NULL;
UPDATE "AnalyticsAggregate" SET "userId" = 'global' WHERE "userId" IS NULL;

-- DropForeignKey（投影表移除组织关系：软删除组织不级联；哨兵 'global' 非真实 org id）
ALTER TABLE "AnalyticsAggregate" DROP CONSTRAINT "AnalyticsAggregate_organizationId_fkey";

-- DropIndex
DROP INDEX "AgentRun_status_idx";

-- ===== T1 前置 1：为全部用户补齐个人组织（ensurePersonalOrganization 同语义：id/slug = personal-{userId}）=====
INSERT INTO "Organization" ("id", "name", "slug", "isPersonal", "ownerUserId", "createdAt", "updatedAt")
SELECT 'personal-' || u.id, COALESCE(NULLIF(u."displayName", ''), u.email) || ' 的个人空间',
       'personal-' || u.id, true, u.id, now(), now()
FROM "User" u
WHERE NOT EXISTS (
  SELECT 1 FROM "Organization" o
  WHERE o."isPersonal" AND o."ownerUserId" = u.id AND o."deletedAt" IS NULL
)
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "OrganizationMember" ("id", "organizationId", "userId", "role", "updatedAt")
SELECT gen_random_uuid(), o.id, o."ownerUserId", 'owner', now()
FROM "Organization" o
WHERE o."isPersonal"
  AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = o."ownerUserId") -- 悬空 owner（用户已删）跳过
  AND NOT EXISTS (
    SELECT 1 FROM "OrganizationMember" m
    WHERE m."organizationId" = o.id AND m."userId" = o."ownerUserId"
  )
ON CONFLICT ("organizationId", "userId") DO NOTHING;

-- ===== T1 前置 2：显式兜底组织（回填链解析不到任何归属时的最后归处；断言保证生产数据不落到这里）=====
INSERT INTO "Organization" ("id", "name", "slug", "isPersonal", "ownerUserId", "createdAt", "updatedAt")
SELECT 'legacy-unattributed', 'Legacy Unattributed Usage', 'legacy-unattributed', false, u.id, now(), now()
FROM "User" u ORDER BY u."createdAt" ASC LIMIT 1
ON CONFLICT ("slug") DO NOTHING;

-- AlterTable（先加可空列 → 回填 → 断言 → SET NOT NULL）
ALTER TABLE "UsageRecord" ADD COLUMN "organizationId" TEXT;

-- ===== T1 回填：事实链逐级解析 =====
UPDATE "UsageRecord" ur
SET "organizationId" = COALESCE(
  (SELECT p."organizationId"
     FROM "AgentRun" ar JOIN "Project" p ON p.id = ar."projectId"
    WHERE ar.id = ur."runId" AND p."organizationId" IS NOT NULL),
  (SELECT p."organizationId"
     FROM "GenerationTask" gt
     JOIN "AgentRun" ar ON ar.id = gt."runId"
     JOIN "Project" p ON p.id = ar."projectId"
    WHERE gt.id = ur."taskId" AND p."organizationId" IS NOT NULL),
  (SELECT p."organizationId"
     FROM "Conversation" c JOIN "Project" p ON p.id = c."projectId"
    WHERE c.id = ur."conversationId" AND p."organizationId" IS NOT NULL),
  (SELECT p."organizationId"
     FROM "Message" m
     JOIN "Conversation" c ON c.id = m."conversationId"
     JOIN "Project" p ON p.id = c."projectId"
    WHERE m.id = ur."messageId" AND p."organizationId" IS NOT NULL),
  (SELECT o.id
     FROM "Organization" o
    WHERE o."isPersonal" AND o."ownerUserId" = ur."userId" AND o."deletedAt" IS NULL),
  'legacy-unattributed'
);

-- ===== T1 断言：绝不允许 silently null——回填不完整则迁移失败 =====
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "UsageRecord" WHERE "organizationId" IS NULL) THEN
    RAISE EXCEPTION 'pre_m9 backfill incomplete: UsageRecord.organizationId still NULL';
  END IF;
END $$;

ALTER TABLE "UsageRecord" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable（S1 约束收紧）
ALTER TABLE "AnalyticsAggregate" ALTER COLUMN "organizationId" SET NOT NULL,
ALTER COLUMN "userId" SET NOT NULL;

-- CreateIndex（P6）
CREATE INDEX "AgentRun_status_leaseUntil_idx" ON "AgentRun"("status", "leaseUntil");
CREATE INDEX "Project_organizationId_idx" ON "Project"("organizationId");
CREATE INDEX "UsageLedgerEntry_organizationId_kind_createdAt_idx" ON "UsageLedgerEntry"("organizationId", "kind", "createdAt");
CREATE INDEX "UsageRecord_organizationId_createdAt_idx" ON "UsageRecord"("organizationId", "createdAt");

-- AddForeignKey（RESTRICT：组织软删除永不影响事实；硬删除被阻断而非级联销毁）
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
