-- M9-P6 市场表落库（幂等 IF NOT EXISTS——真实库的 m9_p6_marketplace 行在整合过程中被真实回滚
-- 但簿记保留 applied；fresh 链上该表已由 m9_p6_marketplace（修正文件）创建，本迁移保证两条路径收敛）。
CREATE TABLE IF NOT EXISTS "ExtensionPublication" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "changelog" JSONB,
    "compatibility" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExtensionPublication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ExtensionReview" (
    "id" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT,
    "moderationStatus" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExtensionReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExtensionPublication_extensionId_key" ON "ExtensionPublication"("extensionId");
CREATE INDEX IF NOT EXISTS "ExtensionPublication_organizationId_idx" ON "ExtensionPublication"("organizationId");
CREATE INDEX IF NOT EXISTS "ExtensionPublication_status_category_idx" ON "ExtensionPublication"("status", "category");
CREATE INDEX IF NOT EXISTS "ExtensionReview_publicationId_moderationStatus_idx" ON "ExtensionReview"("publicationId", "moderationStatus");
CREATE UNIQUE INDEX IF NOT EXISTS "ExtensionReview_publicationId_userId_key" ON "ExtensionReview"("publicationId", "userId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExtensionPublication_organizationId_fkey') THEN
    ALTER TABLE "ExtensionPublication" ADD CONSTRAINT "ExtensionPublication_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExtensionPublication_userId_fkey') THEN
    ALTER TABLE "ExtensionPublication" ADD CONSTRAINT "ExtensionPublication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExtensionReview_publicationId_fkey') THEN
    ALTER TABLE "ExtensionReview" ADD CONSTRAINT "ExtensionReview_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "ExtensionPublication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExtensionReview_userId_fkey') THEN
    ALTER TABLE "ExtensionReview" ADD CONSTRAINT "ExtensionReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
