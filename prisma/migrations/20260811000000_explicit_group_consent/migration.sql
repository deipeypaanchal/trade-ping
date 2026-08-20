BEGIN;

-- Brokerage sync must stay disabled after a disconnect even if a remote
-- authorization could not be revoked immediately.
ALTER TABLE "User"
  ADD COLUMN "brokerSyncEnabled" BOOLEAN NOT NULL DEFAULT false;

UPDATE "User" AS u
SET "brokerSyncEnabled" = true
WHERE EXISTS (
  SELECT 1
  FROM "BrokerConnection" AS bc
  WHERE bc."userId" = u."id"
    AND bc."status" <> 'DISCONNECTED'
);

-- New group interactions must never opt a user into sharing by default.
ALTER TABLE "GroupMember"
  ALTER COLUMN "privacyLevel" SET DEFAULT 'OFF',
  ALTER COLUMN "alertsEnabled" SET DEFAULT false,
  ADD COLUMN "sharingEnabledAt" TIMESTAMP(3);

-- Legacy rows cannot prove that a user still belongs to, or still wants to
-- share with, the group. Require a fresh explicit choice after recovery.
UPDATE "GroupMember"
SET "privacyLevel" = 'OFF',
    "alertsEnabled" = false,
    "sharingEnabledAt" = NULL;

-- A queued outage-era event is safe to deliver only when it falls strictly after
-- an explicit sharing boundary that is still enabled.
UPDATE "TradeEvent" AS te
SET "alertStatus" = 'SKIPPED',
    "backfillStatus" = 'BACKFILL',
    "lastAlertAttemptAt" = CURRENT_TIMESTAMP
WHERE te."alertStatus" IN ('PENDING', 'SENDING')
  AND NOT EXISTS (
    SELECT 1
    FROM "GroupMember" AS gm
    WHERE gm."userId" = te."userId"
      AND gm."groupId" = te."groupId"
      AND gm."alertsEnabled" = true
      AND gm."privacyLevel" <> 'OFF'
      AND gm."sharingEnabledAt" IS NOT NULL
      AND te."tradeTime" > gm."sharingEnabledAt"
  );

ALTER TABLE "GroupMember"
  ADD CONSTRAINT "GroupMember_explicit_sharing_check"
  CHECK (
    ("alertsEnabled" = false AND "sharingEnabledAt" IS NULL)
    OR
    ("alertsEnabled" = true AND "privacyLevel" <> 'OFF' AND "sharingEnabledAt" IS NOT NULL)
  );

COMMIT;
