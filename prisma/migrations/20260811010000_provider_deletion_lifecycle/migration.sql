BEGIN;

-- SnapTrade user deletion is asynchronous. Keep a generation-aware local
-- handle until USER_DELETED confirms the exact provider identity.
CREATE TYPE "ProviderDeletionPurpose" AS ENUM ('ACCOUNT_DELETION', 'SECRET_REPLACEMENT');
CREATE TYPE "ProviderDeletionStatus" AS ENUM ('REGISTRATION', 'READY', 'PENDING', 'CONFIRMED');

ALTER TABLE "User"
  ADD COLUMN "snaptradeGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deletionPendingAt" TIMESTAMP(3),
  ADD COLUMN "deletionBlockReason" TEXT;

CREATE TABLE "ProviderDeletion" (
  "provider" TEXT NOT NULL DEFAULT 'snaptrade',
  "providerUserId" TEXT NOT NULL,
  "localUserId" TEXT,
  "purpose" "ProviderDeletionPurpose" NOT NULL,
  "generation" INTEGER NOT NULL,
  "status" "ProviderDeletionStatus" NOT NULL DEFAULT 'READY',
  "requestedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProviderDeletion_pkey" PRIMARY KEY ("provider", "providerUserId")
);

CREATE INDEX "ProviderDeletion_localUserId_status_idx"
  ON "ProviderDeletion" ("localUserId", "status");
CREATE INDEX "ProviderDeletion_status_lastAttemptAt_idx"
  ON "ProviderDeletion" ("status", "lastAttemptAt");

ALTER TABLE "ProviderDeletion"
  ADD CONSTRAINT "ProviderDeletion_localUserId_fkey"
  FOREIGN KEY ("localUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AuditLog.userId was historically advisory. Remove impossible references
-- before making it a real optional FK so user deletion cannot leave PII-bearing
-- audit rows behind.
-- Older SnapTrade webhook audits stored the raw provider user ID only inside
-- JSON metadata. Attach matching rows to the local user so account deletion can
-- cascade them, then scrub that raw provider identifier from every legacy row
-- (including unmatched/deleted users).
UPDATE "AuditLog" AS audit
SET "userId" = app_user."id"
FROM "User" AS app_user
WHERE audit.action = 'snaptrade_webhook_received'
  AND audit."userId" IS NULL
  AND audit.metadata->>'userId' = app_user."snaptradeUserId";

UPDATE "AuditLog" AS audit
SET metadata = audit.metadata - 'userId'
WHERE audit.action = 'snaptrade_webhook_received'
  AND audit.metadata ? 'userId';

DELETE FROM "AuditLog" AS audit
WHERE audit."userId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "User" AS app_user WHERE app_user."id" = audit."userId"
  );

ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TelegramUpdateCursor" (
  "scopeKey" TEXT NOT NULL,
  "lastUpdateId" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TelegramUpdateCursor_pkey" PRIMARY KEY ("scopeKey")
);

CREATE INDEX "TelegramUpdateCursor_updatedAt_idx"
  ON "TelegramUpdateCursor" ("updatedAt");

-- Prevent delayed Telegram deliveries from silently recreating an identity
-- immediately after account deletion. Only a keyed hash is retained, and the
-- application expires it or clears it on a newer explicit private /start.
CREATE TABLE "TelegramIdentitySuppression" (
  "identityHash" TEXT NOT NULL,
  "localUserId" TEXT,
  "deletedAt" TIMESTAMP(3) NOT NULL,
  "deletionCompletedAt" TIMESTAMP(3),
  "reactivatedAt" TIMESTAMP(3),
  "reactivatedUpdateId" INTEGER,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TelegramIdentitySuppression_pkey" PRIMARY KEY ("identityHash")
);

CREATE INDEX "TelegramIdentitySuppression_expiresAt_idx"
  ON "TelegramIdentitySuppression" ("expiresAt");
CREATE INDEX "TelegramIdentitySuppression_localUserId_idx"
  ON "TelegramIdentitySuppression" ("localUserId");

COMMIT;
