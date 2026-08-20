#!/usr/bin/env bash
set -euo pipefail
umask 077

CUTOFF="${1:-}"
ENV_FILE="${2:-${TRADEPING_CLEANUP_ENV_FILE:-.env.production.local}}"
RECOVERY_RUN_ID="${3:-${TRADEPING_RECOVERY_RUN_ID:-}}"
RELEASE_SHA="${4:-${TRADEPING_RECOVERY_RELEASE_SHA:-}}"
EXPECTED_PG_MAJOR="${TRADEPING_EXPECTED_PG_MAJOR:-18}"
REQUIRE_PUBLIC_URL="${TRADEPING_REQUIRE_PUBLIC_DATABASE_URL:-false}"
REQUIRE_MATCHING_URLS="${TRADEPING_REQUIRE_MATCHING_RAILWAY_DATABASE_URLS:-false}"
PG_CONNECT_TIMEOUT_SECONDS="${TRADEPING_PG_CONNECT_TIMEOUT_SECONDS:-10}"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for recovery validation."
  exit 1
fi
if [[ "$REQUIRE_PUBLIC_URL" != "true" && "$REQUIRE_PUBLIC_URL" != "false" ]] ||
   [[ "$REQUIRE_MATCHING_URLS" != "true" && "$REQUIRE_MATCHING_URLS" != "false" ]]; then
  echo "Public/matching database URL requirements must be true or false."
  exit 1
fi
if [[ "$REQUIRE_MATCHING_URLS" == "true" && "$REQUIRE_PUBLIC_URL" != "true" ]]; then
  echo "Matching Railway database URLs requires the public URL requirement."
  exit 1
fi

usage() {
  cat <<'EOF'
Usage:
  TRADEPING_CLEANUP_CONFIRM=skip-and-clean-<run-id>-before-<cutoff> \
    scripts/recovery-cleanup.sh <cutoff> <env-file> <run-id> <full-release-sha>

The cutoff must be a canonical UTC timestamp such as
2026-07-31T04:00:00.000Z. Reuse the same run ID, cutoff, and release SHA on
every retry. The database records that contract before cleanup begins.
EOF
}

if [[ -z "$CUTOFF" || -z "$RECOVERY_RUN_ID" || -z "$RELEASE_SHA" ]]; then
  usage
  exit 1
fi

if ! node -e '
  const value = process.argv[1];
  const parsed = new Date(value);
  process.exit(Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? 0 : 1);
' "$CUTOFF"; then
  echo "Cutoff must be a canonical UTC ISO timestamp, for example 2026-07-31T04:00:00.000Z."
  exit 1
fi
if [[ ! "$RECOVERY_RUN_ID" =~ ^[A-Za-z0-9._-]{8,100}$ ]]; then
  echo "Recovery run ID must be 8-100 characters using only letters, numbers, dot, underscore, or hyphen."
  exit 1
fi
if [[ ! "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Recovery release SHA must be the full 40-character lowercase Git commit SHA."
  exit 1
fi

EXPECTED_CONFIRMATION="skip-and-clean-$RECOVERY_RUN_ID-before-$CUTOFF"
if [[ "${TRADEPING_CLEANUP_CONFIRM:-}" != "$EXPECTED_CONFIRMATION" ]]; then
  cat <<EOF
Refusing to change production data without an exact recovery-run confirmation.

Set:
  TRADEPING_CLEANUP_CONFIRM=$EXPECTED_CONFIRMATION

This operation preserves users, encrypted SnapTrade secrets, broker
authorizations, accounts, Telegram groups, memberships, privacy settings,
sync baselines, sent alert history, and Alert receipts. It marks only unsent
pre-cutoff TradeEvent rows as BACKFILL/SKIPPED and removes expired webhook
idempotency keys.
EOF
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ "$REQUIRE_PUBLIC_URL" == "true" && -z "${DATABASE_PUBLIC_URL:-}" ]]; then
  echo "DATABASE_PUBLIC_URL is required because cleanup runs outside Railway's private network."
  exit 1
fi
DATABASE_CLEANUP_URL="${DATABASE_PUBLIC_URL:-${DATABASE_URL:-}}"
if [[ -z "$DATABASE_CLEANUP_URL" ]]; then
  echo "Missing DATABASE_PUBLIC_URL or DATABASE_URL."
  exit 1
fi
node -e '
  const net = require("node:net");
  const raw = process.argv[1];
  const requirePublic = process.argv[2] === "true";
  const requireMatch = process.argv[3] === "true";
  const privateRaw = process.argv[4];
  let url;
  try { url = new URL(raw); } catch { process.exit(1); }
  const validProtocol = url.protocol === "postgresql:" || url.protocol === "postgres:";
  const host = url.hostname.toLowerCase().replace(/[.]$/, "").replace(/^\[|\]$/g, "");
  const octets = net.isIP(host) === 4 ? host.split(".").map(Number) : [];
  const privateIpv4 = octets.length === 4 && (octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) || (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  const privateIpv6 = net.isIP(host) === 6 && (host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host));
  const privateHost = host === "localhost" || host.endsWith(".localhost") ||
    host.endsWith(".railway.internal") || privateIpv4 || privateIpv6;
  if (!validProtocol || !host || !url.username || !url.password || (requirePublic && privateHost)) process.exit(1);
  if (requireMatch) {
    let privateUrl;
    try { privateUrl = new URL(privateRaw); } catch { process.exit(1); }
    const privateRailwayHost = privateUrl.hostname.toLowerCase().replace(/[.]$/, "").endsWith(".railway.internal");
    const privateProtocol = privateUrl.protocol === "postgresql:" || privateUrl.protocol === "postgres:";
    if (!privateProtocol || !privateRailwayHost || privateUrl.username !== url.username ||
        privateUrl.password !== url.password || privateUrl.pathname !== url.pathname) process.exit(1);
  }
' "$DATABASE_CLEANUP_URL" "$REQUIRE_PUBLIC_URL" "$REQUIRE_MATCHING_URLS" "${DATABASE_URL:-}" || {
  echo "The selected database URL is invalid, lacks credentials, is not public, or does not match the scoped Railway private URL."
  exit 1
}

pick_psql() {
  local requested="${PSQL_BIN:-}"
  local resolved
  if [[ -n "$requested" ]]; then
    if [[ "$requested" == */* ]]; then
      [[ -x "$requested" ]] || return 1
      printf '%s\n' "$requested"
      return 0
    fi
    resolved="$(command -v "$requested" 2>/dev/null || true)"
    [[ -n "$resolved" && -x "$resolved" ]] || return 1
    printf '%s\n' "$resolved"
    return 0
  fi
  for resolved in \
    /opt/homebrew/opt/postgresql@18/bin/psql \
    /usr/local/opt/postgresql@18/bin/psql \
    /usr/lib/postgresql/18/bin/psql \
    /opt/homebrew/opt/libpq/bin/psql \
    /usr/local/opt/libpq/bin/psql; do
    if [[ -x "$resolved" ]]; then
      printf '%s\n' "$resolved"
      return 0
    fi
  done
  command -v psql 2>/dev/null || return 1
}

PSQL_CMD="$(pick_psql || true)"
if [[ -z "$PSQL_CMD" ]]; then
  echo "PostgreSQL $EXPECTED_PG_MAJOR psql is required but was not found."
  exit 1
fi
psql_major="$("$PSQL_CMD" --version | awk '
  {
    for (i = 1; i <= NF; i += 1) {
      if ($i ~ /^[0-9]+([.][0-9]+)*/) {
        split($i, version, ".");
        print version[1];
        exit;
      }
    }
  }
')"
if [[ ! "$psql_major" =~ ^[0-9]+$ || "$psql_major" -ne "$EXPECTED_PG_MAJOR" ]]; then
  echo "$PSQL_CMD must be PostgreSQL major $EXPECTED_PG_MAJOR (found ${psql_major:-unknown})."
  exit 1
fi
if [[ ! "$PG_CONNECT_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "TRADEPING_PG_CONNECT_TIMEOUT_SECONDS must be a positive integer."
  exit 1
fi

export PGCONNECT_TIMEOUT="$PG_CONNECT_TIMEOUT_SECONDS"
export PGAPPNAME='tradeping-recovery-cleanup'
export PGOPTIONS='-c statement_timeout=120000 -c lock_timeout=15000'

echo "Applying recovery run $RECOVERY_RUN_ID with cutoff $CUTOFF"
"$PSQL_CMD" \
  --dbname="$DATABASE_CLEANUP_URL" \
  --no-psqlrc \
  --no-password \
  --set=ON_ERROR_STOP=1 \
  --set=cutoff="$CUTOFF" \
  --set=recovery_run_id="$RECOVERY_RUN_ID" \
  --set=release_sha="$RELEASE_SHA" \
  --set=expected_pg_major="$EXPECTED_PG_MAJOR" <<'SQL'
BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '2min';
SET LOCAL lock_timeout = '15s';

CREATE TEMP TABLE recovery_run_input ON COMMIT DROP AS
SELECT
  :'recovery_run_id'::text AS run_id,
  :'cutoff'::text AS cutoff_text,
  :'cutoff'::timestamptz AS cutoff_at,
  :'release_sha'::text AS release_sha,
  :'expected_pg_major'::integer AS expected_pg_major;

DO $database_identity$
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <>
       (SELECT expected_pg_major FROM recovery_run_input)
     OR pg_catalog.to_regclass('public."TradeEvent"') IS NULL
     OR pg_catalog.to_regclass('public."AuditLog"') IS NULL
     OR pg_catalog.to_regclass('public."IdempotencyKey"') IS NULL
     OR pg_catalog.to_regclass('public."_prisma_migrations"') IS NULL THEN
    RAISE EXCEPTION 'Connected database is not the expected PG18 TradePing production schema';
  END IF;
END
$database_identity$;

-- One transaction-scoped lock serializes every production cleanup, including
-- retries and accidentally concurrent recovery run IDs.
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('tradeping-production-recovery-cleanup', 0)
);

DO $contract$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public."AuditLog" AS audit_log
      CROSS JOIN recovery_run_input AS input
     WHERE audit_log.action = 'recovery_contract_recorded'
       AND audit_log.metadata->>'runId' = input.run_id
       AND (
         audit_log.metadata->>'cutoff' IS DISTINCT FROM input.cutoff_text
         OR audit_log.metadata->>'releaseSha' IS DISTINCT FROM input.release_sha
       )
  ) THEN
    RAISE EXCEPTION 'Recovery run ID was already recorded with a different cutoff or release SHA';
  END IF;
END
$contract$;

INSERT INTO public."AuditLog" (id, action, metadata, "createdAt")
SELECT
  'recovery-contract-' || pg_catalog.md5(input.run_id),
  'recovery_contract_recorded',
  pg_catalog.jsonb_build_object(
    'runId', input.run_id,
    'cutoff', input.cutoff_text,
    'releaseSha', input.release_sha
  ),
  pg_catalog.now()
FROM recovery_run_input AS input
ON CONFLICT (id) DO NOTHING;

DO $contract_id$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public."AuditLog" AS audit_log
      CROSS JOIN recovery_run_input AS input
     WHERE audit_log.id = 'recovery-contract-' || pg_catalog.md5(input.run_id)
       AND audit_log.action = 'recovery_contract_recorded'
       AND audit_log.metadata->>'runId' = input.run_id
       AND audit_log.metadata->>'cutoff' = input.cutoff_text
       AND audit_log.metadata->>'releaseSha' = input.release_sha
  ) THEN
    RAISE EXCEPTION 'Recovery contract ID collision or inconsistent durable contract';
  END IF;
END
$contract_id$;

CREATE TEMP TABLE recovery_cleanup_stats ON COMMIT DROP AS
SELECT
  (SELECT pg_catalog.count(*)
     FROM public."TradeEvent" AS trade_event
     CROSS JOIN recovery_run_input AS input
    WHERE trade_event."tradeTime" < input.cutoff_at
      AND trade_event."alertStatus" IN ('PENDING', 'SENDING')) AS pre_cutoff_unsent_trades,
  (SELECT pg_catalog.count(*)
     FROM public."IdempotencyKey" AS idempotency_key
    WHERE idempotency_key."expiresAt" < pg_catalog.now()) AS expired_idempotency_keys;

UPDATE public."TradeEvent" AS trade_event
SET
  "backfillStatus" = 'BACKFILL',
  "alertStatus" = 'SKIPPED',
  "lastAlertAttemptAt" = pg_catalog.now()
FROM recovery_run_input AS input
WHERE trade_event."tradeTime" < input.cutoff_at
  AND trade_event."alertStatus" IN ('PENDING', 'SENDING');

DELETE FROM public."IdempotencyKey" AS idempotency_key
WHERE idempotency_key."expiresAt" < pg_catalog.now();

INSERT INTO public."AuditLog" (id, action, metadata, "createdAt")
SELECT
  'recovery-cleanup-' || pg_catalog.md5(input.run_id || pg_catalog.chr(31) || input.cutoff_text),
  'recovery_cutoff_applied',
  pg_catalog.jsonb_build_object(
    'runId', input.run_id,
    'cutoff', input.cutoff_text,
    'releaseSha', input.release_sha,
    'preCutoffUnsentTradesMarkedSkipped', stats.pre_cutoff_unsent_trades,
    'sentHistoryPreserved', true,
    'alertReceiptsPreserved', true,
    'expiredIdempotencyKeysDeleted', stats.expired_idempotency_keys
  ),
  pg_catalog.now()
FROM recovery_run_input AS input
CROSS JOIN recovery_cleanup_stats AS stats
ON CONFLICT (id) DO NOTHING;

TABLE recovery_cleanup_stats;
COMMIT;
SQL

echo "Recovery cleanup complete for run $RECOVERY_RUN_ID."
