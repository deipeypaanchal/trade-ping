-- Adds User.timeZone for per-user alert timezone, plus AuditLog and
-- IdempotencyKey indexes for forensic queries and expiry sweeps.

ALTER TABLE "User" ADD COLUMN "timeZone" TEXT;

CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog" ("action", "createdAt");
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey" ("expiresAt");
