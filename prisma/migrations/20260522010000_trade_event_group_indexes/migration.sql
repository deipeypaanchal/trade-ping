-- Adds groupId-keyed indexes so /groupstatus, Alert lookups, and pending-alert
-- scans stop doing full TradeEvent table scans as history grows.

CREATE INDEX "TradeEvent_groupId_alertStatus_idx" ON "TradeEvent" ("groupId", "alertStatus");
CREATE INDEX "TradeEvent_groupId_tradeTime_idx" ON "TradeEvent" ("groupId", "tradeTime" DESC);
