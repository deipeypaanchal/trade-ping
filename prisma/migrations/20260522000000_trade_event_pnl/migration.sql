ALTER TABLE "TradeEvent" ADD COLUMN "priceSource" TEXT;
ALTER TABLE "TradeEvent" ADD COLUMN "profitLoss" DECIMAL(65,30);
ALTER TABLE "TradeEvent" ADD COLUMN "profitLossPct" DECIMAL(65,30);
