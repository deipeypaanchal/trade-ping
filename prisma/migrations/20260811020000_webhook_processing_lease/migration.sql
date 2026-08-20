BEGIN;

-- A bare idempotency nonce cannot distinguish a completed webhook from a
-- process that died immediately after claiming it. Give each in-flight event a
-- finite, token-owned lease so a provider retry can safely reclaim crashed
-- work while completed events remain a durable replay boundary.
ALTER TABLE "IdempotencyKey"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'COMPLETED',
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "processingToken" TEXT,
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Every pre-migration nonce was written by the old handler as its replay
-- boundary. Preserve that behavior rather than reopening historical events.
UPDATE "IdempotencyKey"
SET "completedAt" = "createdAt"
WHERE "status" = 'COMPLETED' AND "completedAt" IS NULL;

-- Defaults above exist only to backfill deployed rows during ALTER TABLE. New
-- claims must state their lifecycle explicitly.
ALTER TABLE "IdempotencyKey"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "IdempotencyKey"
  ADD CONSTRAINT "IdempotencyKey_status_check"
  CHECK (
    ("status" = 'COMPLETED' AND "leaseUntil" IS NULL AND "processingToken" IS NULL AND "completedAt" IS NOT NULL)
    OR
    ("status" = 'PROCESSING' AND "leaseUntil" IS NOT NULL AND "processingToken" IS NOT NULL AND "completedAt" IS NULL)
  );

CREATE INDEX "IdempotencyKey_status_leaseUntil_idx"
  ON "IdempotencyKey" ("status", "leaseUntil");

COMMIT;
