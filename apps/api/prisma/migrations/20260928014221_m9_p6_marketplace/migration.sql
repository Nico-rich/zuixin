-- DropIndex

-- CreateTable
CREATE TABLE "ExtensionPublication" (
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

-- CreateTable
CREATE TABLE "ExtensionReview" (
    "id" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT,
    "moderationStatus" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtensionReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionPublication_extensionId_key" ON "ExtensionPublication"("extensionId");

-- CreateIndex
CREATE INDEX "ExtensionPublication_organizationId_idx" ON "ExtensionPublication"("organizationId");

-- CreateIndex
CREATE INDEX "ExtensionPublication_status_category_idx" ON "ExtensionPublication"("status", "category");

-- CreateIndex
CREATE INDEX "ExtensionReview_publicationId_moderationStatus_idx" ON "ExtensionReview"("publicationId", "moderationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionReview_publicationId_userId_key" ON "ExtensionReview"("publicationId", "userId");

-- AddForeignKey
ALTER TABLE "ExtensionPublication" ADD CONSTRAINT "ExtensionPublication_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionPublication" ADD CONSTRAINT "ExtensionPublication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionReview" ADD CONSTRAINT "ExtensionReview_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "ExtensionPublication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionReview" ADD CONSTRAINT "ExtensionReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
