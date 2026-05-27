-- Adds option metadata, raw price-component capture, fees, and alert-retry
-- bookkeeping to TradeEvent. All columns nullable so existing rows are
-- preserved without backfill. assetType is left NULL for legacy rows; the
-- renderer falls back to symbol-shape inference when assetType is absent.

ALTER TABLE "TradeEvent" ADD COLUMN IF NOT EXISTS "averageFillPrice" DECIMAL(65,30);
ALTER TABLE "TradeEvent" ADD COLUMN IF NOT EXISTS "executionPrice" DECIMAL(65,30);
ALTER TABLE "TradeEvent" ADD COLUMN IF NOT EXISTS "limitPrice" DECIMAL(65,30);
ALTER TABLE "TradeEvent" ADD COLUMN IF NOT EXISTS "fees" DECIMAL(65,30);
ALTER TABLE "TradeEvent" ADD COLUMN IF NOT EXISTS "assetType" TEXT;
ALTER TABLE "TradeEvent" ADD COLUMN IF NOT EXISTS "underlying" TEXT;
ALTER TABLE "TradeEvent" ADD COLUMN IF NOT EXISTS "optionExpiration" TIMESTAMP(3);
ALTER TABLE "TradeEvent" ADD COLUMN IF NOT EXISTS "optionStrike" DECIMAL(65,30);
ALTER TABLE "TradeEvent" ADD COLUMN IF NOT EXISTS "optionType" TEXT;
ALTER TABLE "TradeEvent" ADD COLUMN IF NOT EXISTS "alertAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TradeEvent" ADD COLUMN IF NOT EXISTS "lastAlertAttemptAt" TIMESTAMP(3);
