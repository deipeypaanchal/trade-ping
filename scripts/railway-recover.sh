#!/usr/bin/env bash
set -euo pipefail

APP_URL="${APP_URL:-https://api-production-4bc3.up.railway.app}"
BRANCH="${RAILWAY_BRANCH:-main}"
REPO="${RAILWAY_REPO:-deipeypaanchal/trade-ping}"
ENV_FILE="${1:-${RAILWAY_RECOVERY_ENV_FILE:-.env.production.local}}"

required_api_vars=(
  APP_BASE_URL
  BACKFILL_SUPPRESS_HOURS
  ENCRYPTION_KEY_BASE64
  INTERNAL_JOB_SECRET
  NODE_ENV
  SNAPTRADE_CLIENT_ID
  SNAPTRADE_CONSUMER_KEY
  SNAPTRADE_REDIRECT_URI
  SNAPTRADE_USE_MOCK
  SYNC_INTERVAL_MINUTES
  TELEGRAM_BOT_TOKEN
  TELEGRAM_BOT_USERNAME
  TELEGRAM_WEBHOOK_SECRET
  TRADE_ORDER_LOOKBACK_DAYS
)

echo "== TradePing Railway recovery =="
railway whoami >/dev/null
railway status || true

service_exists() {
  local service="$1"
  railway service list --json | node -e '
    const fs = require("fs");
    const services = JSON.parse(fs.readFileSync(0, "utf8"));
    const target = process.argv[1].toLowerCase();
    process.exit(services.some((s) => String(s.name).toLowerCase() === target) ? 0 : 1);
  ' "$service"
}

redeploy_or_explain() {
  local service="$1"
  if railway deployment redeploy --service "$service" --from-source -y; then
    return 0
  fi
  cat <<EOF

Railway refused to deploy $service.
If the error is "You have used all your available resources", wait for the
free-plan quota reset or raise the workspace usage limit in Railway, then rerun:

  scripts/railway-recover.sh $ENV_FILE

EOF
  return 1
}

if ! service_exists Postgres; then
  cat <<'EOF'
Postgres service is missing. Refusing to recreate it automatically because that
would create an empty production database and force every user to reconnect.
Restore the original Postgres service/volume first, or explicitly perform a
clean beta reset outside this script.
EOF
  exit 1
fi

echo "== Recovering Postgres =="
redeploy_or_explain Postgres

if ! service_exists Redis; then
  echo "== Recreating Redis =="
  railway add --database redis --json >/dev/null
fi

echo "== Recovering Redis =="
redeploy_or_explain Redis

if ! service_exists api; then
  echo "== Recreating api service =="
  railway add --service api --repo "$REPO" --branch "$BRANCH" --json >/dev/null
fi

if [[ -f "$ENV_FILE" ]]; then
  echo "== Loading API variables from $ENV_FILE =="
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

missing=()
for name in "${required_api_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done

if (( ${#missing[@]} > 0 )); then
  printf 'Missing required API variable(s): %s\n' "${missing[*]}"
  cat <<EOF

Create $ENV_FILE from your private secret manager, or export the variables in
your shell, then rerun this script. Do not commit that file.
EOF
  exit 1
fi

echo "== Setting API variables =="
railway variable set --service api 'DATABASE_URL=${{Postgres.DATABASE_URL}}' --skip-deploys --json >/dev/null
railway variable set --service api 'REDIS_URL=${{Redis.REDIS_URL}}' --skip-deploys --json >/dev/null
release_sha="${RELEASE_SHA:-$(git rev-parse --short=12 HEAD 2>/dev/null || true)}"
if [[ -n "$release_sha" ]]; then
  printf '%s' "$release_sha" | railway variable set --service api --stdin RELEASE_SHA --skip-deploys --json >/dev/null
fi
for name in "${required_api_vars[@]}"; do
  printf '%s' "${!name}" | railway variable set --service api --stdin "$name" --skip-deploys --json >/dev/null
done

echo "== Deploying API =="
railway up --service api --detach --message "recover production after Railway resource reset"

echo "== Waiting for health =="
for _ in $(seq 1 36); do
  if curl -fsS -m 10 "$APP_URL/healthz"; then
    echo
    echo "Recovery complete."
    exit 0
  fi
  sleep 10
done

echo "API did not become healthy within 6 minutes. Inspect logs with:"
echo "  railway logs --service api --lines 300"
exit 1
