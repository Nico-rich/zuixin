-- CreateEnum
CREATE TYPE "OrganizationRole" AS ENUM ('owner', 'admin', 'member', 'viewer');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "ExternalAction" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "organizationId" TEXT;

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isPersonal" BOOLEAN NOT NULL DEFAULT false,
    "ownerUserId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL DEFAULT 'member',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationInvitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL DEFAULT 'member',
    "invitedByUserId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Organization_ownerUserId_idx" ON "Organization"("ownerUserId");

-- CreateIndex
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationInvitation_token_key" ON "OrganizationInvitation"("token");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_organizationId_status_idx" ON "OrganizationInvitation"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAction" ADD CONSTRAINT "ExternalAction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== M8-P1 backfill：存量用户 → Personal Organization + 存量项目挂接（旧数据自动兼容）=====
INSERT INTO "Organization" ("id", "name", "slug", "isPersonal", "ownerUserId", "createdAt", "updatedAt")
SELECT
  'personal-' || "id",
  COALESCE("displayName", "email") || ' 的个人空间',
  'personal-' || "id",
  true,
  "id",
  NOW(),
  NOW()
FROM "User"
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "OrganizationMember" ("id", "organizationId", "userId", "role", "joinedAt", "createdAt", "updatedAt")
SELECT
  'pm-' || "ownerUserId",
  "id",
  "ownerUserId",
  'owner',
  NOW(),
  NOW(),
  NOW()
FROM "Organization"
ON CONFLICT ("organizationId", "userId") DO NOTHING;

UPDATE "Project" p
SET "organizationId" = (SELECT o."id" FROM "Organization" o WHERE o."ownerUserId" = p."userId" AND o."isPersonal" = true LIMIT 1)
WHERE p."organizationId" IS NULL AND p."deletedAt" IS NULL;

UPDATE "Workflow" w
SET "organizationId" = (SELECT o."id" FROM "Organization" o WHERE o."ownerUserId" = w."userId" AND o."isPersonal" = true LIMIT 1)
WHERE w."organizationId" IS NULL;

UPDATE "Connection" c
SET "organizationId" = (SELECT o."id" FROM "Organization" o WHERE o."ownerUserId" = c."userId" AND o."isPersonal" = true LIMIT 1)
WHERE c."organizationId" IS NULL;

UPDATE "ExternalAction" e
SET "organizationId" = (SELECT o."id" FROM "Organization" o WHERE o."ownerUserId" = e."userId" AND o."isPersonal" = true LIMIT 1)
WHERE e."organizationId" IS NULL;
