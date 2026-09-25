-- CreateTable
CREATE TABLE "QuotaReservation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "refId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuotaReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuotaReservation_expiresAt_idx" ON "QuotaReservation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuotaReservation_organizationId_kind_refId_key" ON "QuotaReservation"("organizationId", "kind", "refId");

-- AddForeignKey
ALTER TABLE "QuotaReservation" ADD CONSTRAINT "QuotaReservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
