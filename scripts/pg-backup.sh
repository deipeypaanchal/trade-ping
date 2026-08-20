#!/usr/bin/env bash
set -euo pipefail
umask 077

ENV_FILE="${1:-${TRADEPING_BACKUP_ENV_FILE:-.env.production.local}}"
OUT_DIR="${2:-${TRADEPING_BACKUP_DIR:-backups}}"
MODE="${TRADEPING_BACKUP_MODE:-backup}"
EXPECTED_PG_MAJOR="${TRADEPING_EXPECTED_PG_MAJOR:-18}"
EXPECTED_SOURCE_MB="${TRADEPING_EXPECTED_SOURCE_MB:-0}"
REQUIRE_PUBLIC_URL="${TRADEPING_REQUIRE_PUBLIC_DATABASE_URL:-false}"
REQUIRE_MATCHING_URLS="${TRADEPING_REQUIRE_MATCHING_RAILWAY_DATABASE_URLS:-false}"
PG_CONNECT_TIMEOUT_SECONDS="${TRADEPING_PG_CONNECT_TIMEOUT_SECONDS:-10}"

if [[ -z "$OUT_DIR" || "$OUT_DIR" == *$'\n'* || "$OUT_DIR" == *$'\r'* ]]; then
  echo "Backup output directory must be a non-empty single-line path."
  exit 1
fi

if [[ "$MODE" != "preflight" && "$MODE" != "ready" && "$MODE" != "backup" ]]; then
  echo "TRADEPING_BACKUP_MODE must be preflight, ready, or backup."
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
if [[ ! "$EXPECTED_PG_MAJOR" =~ ^[1-9][0-9]*$ ]]; then
  echo "TRADEPING_EXPECTED_PG_MAJOR must be a positive integer."
  exit 1
fi
if [[ ! "$PG_CONNECT_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "TRADEPING_PG_CONNECT_TIMEOUT_SECONDS must be a positive integer."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is required for backup preflight validation."
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ "$REQUIRE_PUBLIC_URL" == "true" && -z "${DATABASE_PUBLIC_URL:-}" ]]; then
  echo "DATABASE_PUBLIC_URL is required because this backup runs outside Railway's private network."
  exit 1
fi

DATABASE_DUMP_URL="${DATABASE_PUBLIC_URL:-${DATABASE_URL:-}}"
if [[ -z "$DATABASE_DUMP_URL" ]]; then
  cat <<EOF
Missing DATABASE_PUBLIC_URL or DATABASE_URL.

Create $ENV_FILE from your private secret manager, or export one of those
variables, then rerun:

  scripts/pg-backup.sh $ENV_FILE
EOF
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
' "$DATABASE_DUMP_URL" "$REQUIRE_PUBLIC_URL" "$REQUIRE_MATCHING_URLS" "${DATABASE_URL:-}" || {
  echo "The selected database URL is invalid, lacks credentials, is not public, or does not match the scoped Railway private URL."
  exit 1
}

pick_pg_tool() {
  local requested="$1"
  local name="$2"
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
    "/opt/homebrew/opt/postgresql@18/bin/$name" \
    "/usr/local/opt/postgresql@18/bin/$name" \
    "/usr/lib/postgresql/18/bin/$name" \
    "/opt/homebrew/opt/libpq/bin/$name" \
    "/usr/local/opt/libpq/bin/$name"; do
    if [[ -x "$resolved" ]]; then
      printf '%s\n' "$resolved"
      return 0
    fi
  done
  command -v "$name" 2>/dev/null || return 1
}

tool_major() {
  "$1" --version | awk '
    {
      for (i = 1; i <= NF; i += 1) {
        if ($i ~ /^[0-9]+([.][0-9]+)*/) {
          split($i, version, ".");
          print version[1];
          exit;
        }
      }
    }
  '
}

PG_DUMP_CMD="$(pick_pg_tool "${PG_DUMP_BIN:-}" pg_dump || true)"
PG_RESTORE_CMD="$(pick_pg_tool "${PG_RESTORE_BIN:-}" pg_restore || true)"
PSQL_CMD="$(pick_pg_tool "${PSQL_BIN:-}" psql || true)"

if [[ -z "$PG_DUMP_CMD" || -z "$PG_RESTORE_CMD" || -z "$PSQL_CMD" ]]; then
  cat <<'EOF'
pg_dump, pg_restore, and psql are required but were not found.

Install the PostgreSQL 18 client tools first:
  macOS: brew install postgresql@18
  Debian/Ubuntu: sudo apt-get install postgresql-client-18
EOF
  exit 1
fi

for tool in "$PG_DUMP_CMD" "$PG_RESTORE_CMD" "$PSQL_CMD"; do
  major="$(tool_major "$tool")"
  if [[ ! "$major" =~ ^[0-9]+$ || "$major" -ne "$EXPECTED_PG_MAJOR" ]]; then
    echo "$tool must be PostgreSQL major $EXPECTED_PG_MAJOR (found ${major:-unknown})."
    exit 1
  fi
done

if command -v shasum >/dev/null 2>&1; then
  SHA256_KIND=shasum
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256_KIND=sha256sum
else
  echo "shasum or sha256sum is required."
  exit 1
fi

if [[ -L "$OUT_DIR" ]]; then
  echo "Backup output directory must not be a symlink."
  exit 1
fi
mkdir -p -m 700 "$OUT_DIR"
chmod 700 "$OUT_DIR"

if [[ ! "$EXPECTED_SOURCE_MB" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "TRADEPING_EXPECTED_SOURCE_MB must be numeric."
  exit 1
fi
required_kb="$(node -e '
  const sourceMb = Number(process.argv[1]);
  const minimumMb = Math.max(1024, Math.ceil(sourceMb * 3));
  process.stdout.write(String(minimumMb * 1024));
' "$EXPECTED_SOURCE_MB")"
available_kb="$(df -Pk "$OUT_DIR" | awk 'END { print $4 }')"
if [[ ! "$available_kb" =~ ^[0-9]+$ || "$available_kb" -lt "$required_kb" ]]; then
  echo "Insufficient free space for a safe backup (need at least $required_kb KiB, found ${available_kb:-unknown} KiB)."
  exit 1
fi

if [[ "$MODE" == "preflight" ]]; then
  echo "PostgreSQL $EXPECTED_PG_MAJOR backup preflight passed."
  exit 0
fi

export PGCONNECT_TIMEOUT="$PG_CONNECT_TIMEOUT_SECONDS"
export PGAPPNAME='tradeping-pg-backup'
server_info="$(PGOPTIONS='-c statement_timeout=30000' "$PSQL_CMD" \
  --dbname="$DATABASE_DUMP_URL" \
  --no-psqlrc \
  --no-password \
  --tuples-only \
  --no-align \
  --set=ON_ERROR_STOP=1 \
  --command="SELECT current_setting('server_version_num'), current_database(), to_regclass('public.\"TradeEvent\"') IS NOT NULL, to_regclass('public.\"AuditLog\"') IS NOT NULL, to_regclass('public.\"_prisma_migrations\"') IS NOT NULL")"
IFS='|' read -r server_version_num database_name has_trade_events has_audit_logs has_migrations <<<"${server_info//[[:space:]]/}"
if [[ ! "$server_version_num" =~ ^[0-9]+$ ]]; then
  echo "Could not determine the PostgreSQL server version."
  exit 1
fi
server_major=$((server_version_num / 10000))
if (( server_major != EXPECTED_PG_MAJOR )); then
  echo "Expected PostgreSQL server major $EXPECTED_PG_MAJOR, found $server_major."
  exit 1
fi
if [[ -z "$database_name" || "$has_trade_events" != "t" || "$has_audit_logs" != "t" || "$has_migrations" != "t" ]]; then
  echo "Connected database does not contain the expected TradePing production schema."
  exit 1
fi

if [[ "$MODE" == "ready" ]]; then
  echo "PostgreSQL $server_major is ready with the expected TradePing schema."
  exit 0
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp="$(mktemp "$OUT_DIR/.tradeping-postgres-$timestamp.XXXXXX")"
suffix="${tmp##*.}"
backup="$OUT_DIR/tradeping-postgres-$timestamp-$suffix.dump"
checksum="$backup.sha256"
trap 'rm -f "$tmp" "$checksum.tmp"' EXIT

echo "Creating Postgres backup at $backup"
PGOPTIONS='' "$PG_DUMP_CMD" \
  --no-password \
  --format=custom \
  --no-owner \
  --no-acl \
  --lock-wait-timeout=30s \
  --file "$tmp" \
  --dbname="$DATABASE_DUMP_URL"

# Listing validates the archive table of contents. Rendering every archived
# object forces pg_restore to read and decompress the full payload as well.
"$PG_RESTORE_CMD" --list "$tmp" >/dev/null
"$PG_RESTORE_CMD" --exit-on-error --no-owner --no-acl --file=/dev/null "$tmp"
[[ -s "$tmp" ]] || { echo "Backup archive is empty."; exit 1; }
chmod 600 "$tmp"
mv -n "$tmp" "$backup"
if [[ -e "$tmp" || ! -f "$backup" ]]; then
  echo "Backup filename collision detected; the existing archive was preserved."
  exit 1
fi
# Once the archive has been published under its unique name, remove it again if
# any mandatory checksum step fails. A successful run always leaves both files.
trap 'rm -f "$checksum.tmp" "$backup"' EXIT

if [[ "$SHA256_KIND" == "shasum" ]]; then
  hash="$(shasum -a 256 "$backup" | awk '{print $1}')"
  verify_hash="$(shasum -a 256 "$backup" | awk '{print $1}')"
else
  hash="$(sha256sum "$backup" | awk '{print $1}')"
  verify_hash="$(sha256sum "$backup" | awk '{print $1}')"
fi
if [[ -z "$hash" || "$hash" != "$verify_hash" ]]; then
  echo "Backup checksum verification failed."
  exit 1
fi
printf '%s  %s\n' "$hash" "$(basename "$backup")" > "$checksum.tmp"
chmod 600 "$checksum.tmp"
mv -n "$checksum.tmp" "$checksum"
if [[ -e "$checksum.tmp" || ! -f "$checksum" ]]; then
  echo "Checksum filename collision detected; the existing checksum was preserved."
  exit 1
fi
trap 'rm -f "$checksum" "$backup"' EXIT
if [[ "$SHA256_KIND" == "shasum" ]]; then
  (cd "$OUT_DIR" && shasum -a 256 --check "$(basename "$checksum")") >/dev/null
else
  (cd "$OUT_DIR" && sha256sum --check "$(basename "$checksum")") >/dev/null
fi
trap - EXIT

echo "SHA-256 written to $checksum"
echo "BACKUP_FILE=$backup"
echo "Backup complete and full archive read-check passed."
