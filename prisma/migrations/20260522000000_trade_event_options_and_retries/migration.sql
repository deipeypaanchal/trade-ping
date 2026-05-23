-- Adds option metadata, raw price-component capture, fees, and alert-retry
-- bookkeeping to TradeEvent. All columns nullable so existing rows are
-- preserved without backfill. assetType is left NULL for legacy rows; the
-- renderer falls back to symbol-shape inference when assetType is absent.

ALTER TABLE "TradeEvent" ADD COLUMN "averageFillPrice" DECIMAL(65,30);
ALTER TABLE "TradeEvent" ADD COLUMN "executionPrice" DECIMAL(65,30);
ALTER TABLE "TradeEvent" ADD COLUMN "limitPrice" DECIMAL(65,30);
ALTER TABLE "TradeEvent" ADD COLUMN "fees" DECIMAL(65,30);
ALTER TABLE "TradeEvent" ADD COLUMN "assetType" TEXT;
ALTER TABLE "TradeEvent" ADD COLUMN "underlying" TEXT;
ALTER TABLE "TradeEvent" ADD COLUMN "optionExpiration" TIMESTAMP(3);
ALTER TABLE "TradeEvent" ADD COLUMN "optionStrike" DECIMAL(65,30);
ALTER TABLE "TradeEvent" ADD COLUMN "optionType" TEXT;
ALTER TABLE "TradeEvent" ADD COLUMN "alertAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TradeEvent" ADD COLUMN "lastAlertAttemptAt" TIMESTAMP(3);
