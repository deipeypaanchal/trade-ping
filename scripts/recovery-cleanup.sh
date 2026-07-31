#!/usr/bin/env bash
set -euo pipefail

CUTOFF="${1:-}"
ENV_FILE="${2:-${TRADEPING_CLEANUP_ENV_FILE:-.env.production.local}}"
EXPECTED_CONFIRMATION="skip-and-clean-before-$CUTOFF"

if [[ -z "$CUTOFF" ]]; then
  cat <<'EOF'
Missing cutoff timestamp.

Usage:
  TRADEPING_CLEANUP_CONFIRM=skip-and-clean-before-2026-07-31T04:00:00.000Z \
    scripts/recovery-cleanup.sh 2026-07-31T04:00:00.000Z .env.production.local
EOF
  exit 1
fi

if ! node -e 'const value = process.argv[1]; const parsed = new Date(value); process.exit(Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? 0 : 1)' "$CUTOFF"; then
  echo "Cutoff must be a canonical UTC ISO timestamp, for example 2026-07-31T04:00:00.000Z."
  exit 1
fi

if [[ "${TRADEPING_CLEANUP_CONFIRM:-}" != "$EXPECTED_CONFIRMATION" ]]; then
  cat <<EOF
Refusing to change production data without an exact confirmation.

Set:
  TRADEPING_CLEANUP_CONFIRM=$EXPECTED_CONFIRMATION

This operation preserves users, encrypted SnapTrade secrets, broker
authorizations, accounts, Telegram groups, memberships, privacy settings, and
sync baselines. It marks all pre-cutoff trades as BACKFILL/SKIPPED, deletes
their rendered alert records, and removes expired webhook idempotency keys.
EOF
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DATABASE_CLEANUP_URL="${DATABASE_PUBLIC_URL:-${DATABASE_URL:-}}"
if [[ -z "$DATABASE_CLEANUP_URL" ]]; then
  echo "Missing DATABASE_PUBLIC_URL or DATABASE_URL."
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required but was not found."
  exit 1
fi

echo "Applying recovery cutoff $CUTOFF"
psql "$DATABASE_CLEANUP_URL" \
  --set=ON_ERROR_STOP=1 \
  --set=cutoff="$CUTOFF" <<'SQL'
BEGIN;

CREATE TEMP TABLE recovery_cleanup_stats AS
SELECT
  (SELECT count(*) FROM "TradeEvent" WHERE "tradeTime" < :'cutoff'::timestamptz) AS pre_cutoff_trades,
  (SELECT count(*)
     FROM "Alert" a
     JOIN "TradeEvent" t ON t.id = a."tradeEventId"
    WHERE t."tradeTime" < :'cutoff'::timestamptz) AS pre_cutoff_alerts,
  (SELECT count(*) FROM "IdempotencyKey" WHERE "expiresAt" < now()) AS expired_idempotency_keys;

UPDATE "TradeEvent"
SET
  "backfillStatus" = 'BACKFILL',
  "alertStatus" = 'SKIPPED',
  "lastAlertAttemptAt" = now()
WHERE "tradeTime" < :'cutoff'::timestamptz;

DELETE FROM "Alert"
WHERE "tradeEventId" IN (
  SELECT id FROM "TradeEvent" WHERE "tradeTime" < :'cutoff'::timestamptz
);

DELETE FROM "IdempotencyKey" WHERE "expiresAt" < now();

INSERT INTO "AuditLog" (id, action, metadata, "createdAt")
VALUES (
  concat('recovery-', md5(random()::text || clock_timestamp()::text)),
  'recovery_cutoff_applied',
  jsonb_build_object(
    'cutoff', :'cutoff',
    'preCutoffTradesMarkedSkipped', (SELECT pre_cutoff_trades FROM recovery_cleanup_stats),
    'preCutoffAlertRowsDeleted', (SELECT pre_cutoff_alerts FROM recovery_cleanup_stats),
    'expiredIdempotencyKeysDeleted', (SELECT expired_idempotency_keys FROM recovery_cleanup_stats)
  ),
  now()
);

TABLE recovery_cleanup_stats;
COMMIT;
SQL

echo "Recovery cleanup complete."
