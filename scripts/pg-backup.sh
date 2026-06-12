#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-${TRADEPING_BACKUP_ENV_FILE:-.env.production.local}}"
OUT_DIR="${2:-${TRADEPING_BACKUP_DIR:-backups}}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DATABASE_DUMP_URL="${DATABASE_PUBLIC_URL:-${DATABASE_URL:-}}"
if [[ -z "$DATABASE_DUMP_URL" ]]; then
  cat <<EOF
Missing DATABASE_PUBLIC_URL or DATABASE_URL.

Create $ENV_FILE from your private secret manager, or export one of those
variables in your shell, then rerun:

  scripts/pg-backup.sh $ENV_FILE
EOF
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  cat <<'EOF'
pg_dump is required but was not found.

Install the PostgreSQL client tools first:
  macOS: brew install libpq && brew link --force libpq
  Debian/Ubuntu: sudo apt-get install postgresql-client
EOF
  exit 1
fi

mkdir -p "$OUT_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$OUT_DIR/tradeping-postgres-$timestamp.dump"
tmp="$backup.tmp"

echo "Creating Postgres backup at $backup"
pg_dump --format=custom --no-owner --no-acl --file "$tmp" "$DATABASE_DUMP_URL"
mv "$tmp" "$backup"

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$backup" > "$backup.sha256"
  echo "SHA-256 written to $backup.sha256"
fi

echo "Backup complete."
