-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "deviceId" TEXT;

-- CreateIndex
CREATE INDEX "Session_userId_deviceId_idx" ON "Session"("userId", "deviceId");


-- ===== M11 W0 S2：DB 级 CHECK 不变量（收窄版——仅财务/安全后果项；Prisma 无 @check，手写幂等段）=====
-- 存量脏行已预检（quota/ledger/tokens 三类均 0 违例）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'QuotaReservation_quantity_positive') THEN
    ALTER TABLE "QuotaReservation" ADD CONSTRAINT "QuotaReservation_quantity_positive" CHECK ("quantity" > 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UsageLedgerEntry_quantity_nonneg') THEN
    ALTER TABLE "UsageLedgerEntry" ADD CONSTRAINT "UsageLedgerEntry_quantity_nonneg" CHECK ("quantity" >= 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UsageRecord_tokens_nonneg') THEN
    ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_tokens_nonneg" CHECK ("inputTokens" >= 0 AND "outputTokens" >= 0);
  END IF;
END $$;
