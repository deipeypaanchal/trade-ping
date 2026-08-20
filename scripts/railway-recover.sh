#!/usr/bin/env bash
set -euo pipefail
umask 077

# This runbook is intentionally pinned to the known TradePing production
# resources. Changing any identifier or digest is a reviewed code change, not
# an environment-variable override at incident time.
readonly PROJECT_ID='12deefd6-65c7-4f9a-8d53-63d922d8a63a'
readonly ENVIRONMENT_ID='adcf8049-c534-4642-91fb-ec8cd9bb4f97'
readonly ENVIRONMENT_NAME='production'
readonly POSTGRES_SERVICE_ID='da6d2827-e927-42f7-a0e5-4cec64d846a0'
readonly POSTGRES_SERVICE_NAME='Postgres'
readonly POSTGRES_VOLUME_ID='98242703-8332-438c-ad06-20dfecc30be6'
readonly POSTGRES_VOLUME_MOUNT='/var/lib/postgresql/data'
readonly POSTGRES_IMAGE='ghcr.io/railwayapp-templates/postgres-ssl@sha256:9c3b906629de3a217055e67d44b35d3393b50289d8a0d57949ea76e2be490727'
readonly POSTGRES_IMAGE_DIGEST='sha256:9c3b906629de3a217055e67d44b35d3393b50289d8a0d57949ea76e2be490727'
readonly HISTORICAL_API_SERVICE_ID='0c264347-c37d-415b-a80a-82f269c4a4c2'
readonly API_SERVICE_NAME='api'
readonly API_DOMAIN_ID='2f87f191-8038-41d4-a6cd-d359f13a397b'
readonly API_ORIGIN='https://api-production-4bc3.up.railway.app'
readonly REDIS_SERVICE_ID='72e06384-e1f9-439d-9763-9885105cdff3'
readonly REDIS_SERVICE_NAME='Redis'
readonly REDIS_IMAGE='redis@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99'
readonly REDIS_IMAGE_DIGEST='sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99'
readonly RELEASE_BRANCH='main'
readonly ORIGIN_URL='https://github.com/deipeypaanchal/trade-ping.git'
readonly EXPECTED_PG_MAJOR='18'
readonly MIN_RAILWAY_CLI_VERSION='5.30.4'

ENV_FILE="${1:-${RAILWAY_RECOVERY_ENV_FILE:-}}"
# Keep the production archive outside `railway up .`'s upload context. The
# Docker ignore rules are defense in depth; recovery refuses an in-repo path.
BACKUP_DIR="${TRADEPING_BACKUP_DIR:-../tradeping-backups}"
CUTOFF="${RECOVERY_SUPPRESS_BEFORE:-}"
RECOVERY_RUN_ID="${RECOVERY_RUN_ID:-}"
RECOVERY_CONFIRM="${TRADEPING_RECOVERY_CONFIRM:-}"
PREFLIGHT_ONLY="${TRADEPING_RECOVERY_PREFLIGHT_ONLY:-false}"
REPLACEMENT_API_SERVICE_ID="${TRADEPING_REPLACEMENT_API_SERVICE_ID:-}"
REPLACEMENT_API_DOMAIN_ID="${TRADEPING_REPLACEMENT_API_DOMAIN_ID:-}"
REPLACEMENT_REDIS_SERVICE_ID="${TRADEPING_REPLACEMENT_REDIS_SERVICE_ID:-}"
NEW_DEPLOYMENT_WAIT_SECONDS="${TRADEPING_NEW_DEPLOYMENT_WAIT_SECONDS:-120}"
DEPLOYMENT_WAIT_SECONDS="${TRADEPING_DEPLOYMENT_WAIT_SECONDS:-1200}"
READINESS_WAIT_SECONDS="${TRADEPING_READINESS_WAIT_SECONDS:-300}"
HEALTH_WAIT_SECONDS="${TRADEPING_HEALTH_WAIT_SECONDS:-360}"
WEBHOOK_WAIT_SECONDS="${TRADEPING_WEBHOOK_WAIT_SECONDS:-120}"
POLL_SECONDS="${TRADEPING_POLL_SECONDS:-5}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

note() {
  echo "$*" >&2
}

require_positive_integer() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || die "$name must be a positive integer."
}

canonical_utc_timestamp() {
  node -e '
    const value = process.argv[1];
    const parsed = new Date(value);
    process.exit(Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? 0 : 1);
  ' "$1"
}

valid_uuid() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
}

railway_status_json() {
  railway status \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --json
}

railway_services_json() {
  railway service list \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --json
}

railway_deployments_json() {
  local service_id="$1"
  railway deployment list \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --service "$service_id" \
    --limit 100 \
    --json
}

assert_target_and_volume() {
  railway_status_json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const payload = JSON.parse(input);
      const [projectId, environmentId, environmentName, serviceId, serviceName, volumeId, mountPath] = process.argv.slice(1);
      if (payload.id !== projectId || payload.deletedAt) throw new Error("wrong or deleted Railway project");
      const environments = payload.environments?.edges?.map((edge) => edge.node) ?? [];
      const environment = environments.find((item) => item.id === environmentId);
      if (!environment || environment.name !== environmentName || environment.deletedAt || !environment.canAccess) {
        throw new Error("wrong, deleted, or inaccessible Railway environment");
      }
      const instances = environment.serviceInstances?.edges?.map((edge) => edge.node) ?? [];
      const postgres = instances.find((item) => item.serviceId === serviceId);
      if (!postgres || postgres.serviceName !== serviceName || postgres.environmentId !== environmentId) {
        throw new Error("expected Postgres service instance is missing");
      }
      const volumes = environment.volumeInstances?.edges?.map((edge) => edge.node) ?? [];
      const volume = volumes.find((item) => item.volume?.id === volumeId);
      if (!volume || volume.serviceId !== serviceId || volume.environmentId !== environmentId ||
          volume.mountPath !== mountPath || String(volume.state).toUpperCase() !== "READY" ||
          volume.deletedAt || volume.isPendingDeletion || !(Number(volume.currentSizeMB) > 0) ||
          !(Number(volume.sizeMB) - Number(volume.currentSizeMB) >= 64)) {
        throw new Error("expected READY non-empty Postgres volume is not attached at the pinned mount or lacks 64 MB headroom");
      }
      process.stdout.write(String(volume.currentSizeMB));
    });
  ' "$PROJECT_ID" "$ENVIRONMENT_ID" "$ENVIRONMENT_NAME" \
    "$POSTGRES_SERVICE_ID" "$POSTGRES_SERVICE_NAME" \
    "$POSTGRES_VOLUME_ID" "$POSTGRES_VOLUME_MOUNT"
}

assert_ambient_target_for_add() {
  # `railway add` and `railway environment list` have no project/environment
  # selectors in CLI 5.30.4. Every use is immediately preceded by this exact
  # read-only linkage assertion.
  railway status --json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const payload = JSON.parse(input);
      const environment = payload.environments?.edges?.map((edge) => edge.node)
        .find((item) => item.id === process.argv[2]);
      if (payload.id !== process.argv[1] || !environment || environment.name !== process.argv[3]) process.exit(1);
    });
  ' "$PROJECT_ID" "$ENVIRONMENT_ID" "$ENVIRONMENT_NAME" || \
    die "Railway's ambient link is not the pinned project and production environment."
}

assert_single_project_environment() {
  # Image sources are service-level Railway configuration. Refuse to change a
  # source if this project later gains another environment, where the blast
  # radius would need a fresh review. `environment list` has no target flags.
  assert_ambient_target_for_add
  railway environment list --json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const payload = JSON.parse(input);
      const environments = Array.isArray(payload) ? payload : payload.environments ?? [];
      if (environments.length !== 1 || environments[0].id !== process.argv[1] ||
          environments[0].name !== process.argv[2] || environments[0].isEphemeral || environments[0].restricted) {
        process.exit(1);
      }
    });
  ' "$ENVIRONMENT_ID" "$ENVIRONMENT_NAME" || \
    die "The pinned project no longer has exactly one unrestricted production environment; source changes require review."
}

service_id_by_name() {
  local service_name="$1"
  railway_services_json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const services = JSON.parse(input);
      const matches = services.filter((item) => item.name === process.argv[1]);
      if (matches.length > 1) process.exit(2);
      process.stdout.write(matches[0]?.id ?? "");
    });
  ' "$service_name"
}

service_source_image() {
  local service_id="$1"
  railway_services_json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const services = JSON.parse(input);
      const service = services.find((item) => item.id === process.argv[1]);
      if (!service) process.exit(1);
      process.stdout.write(service.source?.image ?? "");
    });
  ' "$service_id"
}

assert_service_identity() {
  local service_name="$1"
  local actual_id="$2"
  local historical_id="$3"
  local replacement_id="${4:-}"
  [[ -n "$actual_id" ]] || die "Railway service $service_name is missing."
  if [[ "$actual_id" != "$historical_id" && "$actual_id" != "$replacement_id" ]]; then
    die "Railway service $service_name has unexpected ID $actual_id. Expected $historical_id, or explicitly confirm it with the replacement-service environment variable."
  fi
}

assert_api_domain() {
  local api_service_id="$1"
  local actual_domain_id
  actual_domain_id="$(railway domain list \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --service "$api_service_id" \
    --json | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => input += chunk);
      process.stdin.on("end", () => {
        const payload = JSON.parse(input);
        const domains = Array.isArray(payload) ? payload : payload.domains ?? [];
        const expected = new URL(process.argv[1]);
        const domain = domains.find((item) => item.domain === expected.hostname);
        if (!domain || domain.targetPort !== 3000 || String(domain.syncStatus).toUpperCase() !== "ACTIVE") process.exit(1);
        process.stdout.write(domain.id);
      });
    ' "$API_ORIGIN")" || \
      die "The pinned API domain is not ACTIVE on port 3000 for the pinned API service. Refusing to validate or clean up against another host."
  if [[ "$actual_domain_id" != "$API_DOMAIN_ID" && "$actual_domain_id" != "$REPLACEMENT_API_DOMAIN_ID" ]]; then
    die "The canonical API hostname has unconfirmed domain ID $actual_domain_id. Set TRADEPING_REPLACEMENT_API_DOMAIN_ID=$actual_domain_id only after verifying that exact replacement domain."
  fi
}

assert_api_source_less() {
  local api_service_id="$1"
  railway_services_json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const service = JSON.parse(input).find((item) => item.id === process.argv[1]);
      if (!service || service.source?.repo || service.source?.image) process.exit(1);
    });
  ' "$api_service_id" || die "The API service must remain source-less so a GitHub/image autodeploy cannot race the exact local upload."
}

assert_api_offline() {
  local api_service_id="$1"
  railway_status_json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const payload = JSON.parse(input);
      const environment = payload.environments?.edges?.map((edge) => edge.node)
        .find((item) => item.id === process.argv[1]);
      const instance = environment?.serviceInstances?.edges?.map((edge) => edge.node)
        .find((item) => item.serviceId === process.argv[2]);
      if (!instance) process.exit(1);
      const active = Array.isArray(instance.activeDeployments)
        ? instance.activeDeployments
        : instance.activeDeployments?.edges?.map((edge) => edge.node) ?? [];
      if (active.length !== 0) process.exit(1);
    });
  ' "$ENVIRONMENT_ID" "$api_service_id" || die "The API has an active deployment; recovery cleanup requires the API to be offline."

  railway_deployments_json "$api_service_id" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const deployments = JSON.parse(input);
      const terminalOffline = new Set(["REMOVED", "FAILED", "CRASHED", "CANCELED", "CANCELLED", "SKIPPED"]);
      if (deployments.some((item) => !terminalOffline.has(String(item.status).toUpperCase()))) process.exit(1);
    });
  ' || die "The API has a live or in-progress deployment; recovery cleanup requires it to be offline."
}

deployment_ids_json() {
  local service_id="$1"
  railway_deployments_json "$service_id" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => process.stdout.write(JSON.stringify(JSON.parse(input).map((item) => item.id))));
  '
}

new_deployment_once() {
  local service_id="$1"
  local before_ids="$2"
  railway_deployments_json "$service_id" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const before = new Set(JSON.parse(process.argv[1]));
      const created = JSON.parse(input).filter((item) => !before.has(item.id));
      if (created.length !== 1) process.exit(created.length > 1 ? 2 : 1);
      process.stdout.write(created[0].id);
    });
  ' "$before_ids"
}

wait_for_new_deployment() {
  local service_id="$1"
  local before_ids="$2"
  local label="$3"
  local started=$SECONDS
  local candidate
  local result
  while (( SECONDS - started < NEW_DEPLOYMENT_WAIT_SECONDS )); do
    result="$(railway_deployments_json "$service_id" | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => input += chunk);
      process.stdin.on("end", () => {
        const deployments = JSON.parse(input);
        const before = new Set(JSON.parse(process.argv[1]));
        const created = deployments.filter((item) => !before.has(item.id));
        if (created.length > 1) process.exit(2);
        process.stdout.write(created[0]?.id ?? "");
      });
    ' "$before_ids")" || die "More than one new $label deployment appeared; refusing to guess which release is ours."
    if [[ -n "$result" ]]; then
      candidate="$result"
      printf '%s\n' "$candidate"
      return 0
    fi
    sleep "$POLL_SECONDS"
  done
  return 1
}

deployment_info() {
  local service_id="$1"
  local deployment_id="$2"
  railway_deployments_json "$service_id" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const deployment = JSON.parse(input).find((item) => item.id === process.argv[1]);
      if (!deployment) process.exit(1);
      process.stdout.write(JSON.stringify({
        id: deployment.id,
        status: String(deployment.status).toUpperCase(),
        createdAt: deployment.createdAt,
        imageDigest: deployment.meta?.imageDigest ?? "",
        volumeMounts: deployment.meta?.volumeMounts ?? []
      }));
    });
  ' "$deployment_id"
}

wait_for_deployment_success() {
  local service_id="$1"
  local deployment_id="$2"
  local label="$3"
  local expected_digest="${4:-}"
  local expected_mount="${5:-}"
  local started=$SECONDS
  local info status
  while (( SECONDS - started < DEPLOYMENT_WAIT_SECONDS )); do
    info="$(deployment_info "$service_id" "$deployment_id" 2>/dev/null || true)"
    if [[ -n "$info" ]]; then
      status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).status)' "$info")"
      case "$status" in
        SUCCESS|SLEEPING)
          node -e '
            const info = JSON.parse(process.argv[1]);
            const expectedDigest = process.argv[2];
            const expectedMount = process.argv[3];
            if (expectedDigest && info.imageDigest !== expectedDigest) process.exit(1);
            if (expectedMount && !info.volumeMounts.includes(expectedMount)) process.exit(1);
            if (!Number.isFinite(Date.parse(info.createdAt))) process.exit(1);
          ' "$info" "$expected_digest" "$expected_mount" || \
            die "$label deployment $deployment_id succeeded with the wrong image digest, volume mount, or timestamp."
          node -e 'process.stdout.write(JSON.parse(process.argv[1]).createdAt)' "$info"
          return 0
          ;;
        FAILED|CRASHED|REMOVED|REMOVING|CANCELED|CANCELLED|SKIPPED)
          die "$label deployment $deployment_id entered terminal status $status."
          ;;
      esac
    fi
    sleep "$POLL_SECONDS"
  done
  die "Timed out waiting for exact $label deployment $deployment_id."
}

latest_success_with_digest() {
  local service_id="$1"
  local expected_digest="$2"
  railway_deployments_json "$service_id" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const deployment = JSON.parse(input)[0];
      const valid = deployment && ["SUCCESS", "SLEEPING"].includes(String(deployment.status).toUpperCase()) &&
        deployment.meta?.imageDigest === process.argv[1];
      process.stdout.write(valid ? deployment.id : "");
    });
  ' "$expected_digest"
}

latest_inflight_with_digest() {
  local service_id="$1"
  local expected_digest="$2"
  railway_deployments_json "$service_id" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const inFlight = new Set(["BUILDING", "DEPLOYING", "INITIALIZING", "NEEDS_APPROVAL", "QUEUED", "WAITING"]);
      const deployment = JSON.parse(input)[0];
      const valid = deployment && inFlight.has(String(deployment.status).toUpperCase()) &&
        (!deployment.meta?.imageDigest || deployment.meta.imageDigest === process.argv[1]);
      process.stdout.write(valid ? deployment.id : "");
    });
  ' "$expected_digest"
}

assert_source_image() {
  local service_id="$1"
  local expected_image="$2"
  local label="$3"
  local actual
  actual="$(service_source_image "$service_id")"
  [[ "$actual" == "$expected_image" ]] || die "$label source is not pinned to $expected_image (found ${actual:-none})."
}

wait_for_source_image() {
  local service_id="$1"
  local expected_image="$2"
  local label="$3"
  local started=$SECONDS
  while (( SECONDS - started < NEW_DEPLOYMENT_WAIT_SECONDS )); do
    if [[ "$(service_source_image "$service_id")" == "$expected_image" ]]; then
      return 0
    fi
    sleep "$POLL_SECONDS"
  done
  die "$label source did not settle on the pinned digest reference $expected_image."
}

start_pinned_image_deployment() {
  local service_id="$1"
  local image="$2"
  local label="$3"
  local before_ids deployment_id
  before_ids="$(deployment_ids_json "$service_id")"
  if [[ "$(service_source_image "$service_id")" == "$image" ]]; then
    railway deployment redeploy \
      --project "$PROJECT_ID" \
      --environment "$ENVIRONMENT_ID" \
      --service "$service_id" \
      --from-source \
      --yes \
      --json >/dev/null
    deployment_id="$(wait_for_new_deployment "$service_id" "$before_ids" "$label")" || \
      die "Pinned $label source did not create a new deployment."
    printf '%s\n' "$deployment_id"
    return 0
  fi
  railway service source connect \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --service "$service_id" \
    --image "$image" \
    --json >/dev/null
  wait_for_source_image "$service_id" "$image" "$label"
  if deployment_id="$(wait_for_new_deployment "$service_id" "$before_ids" "$label")"; then
    printf '%s\n' "$deployment_id"
    return 0
  fi

  note "$label source was pinned but did not create a deployment; explicitly deploying from that pinned source."
  before_ids="$(deployment_ids_json "$service_id")"
  railway deployment redeploy \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --service "$service_id" \
    --from-source \
    --yes \
    --json >/dev/null
  deployment_id="$(wait_for_new_deployment "$service_id" "$before_ids" "$label")" || \
    die "Pinned $label source did not create a new deployment."
  printf '%s\n' "$deployment_id"
}

run_postgres_tool() {
  local mode="$1"
  railway run \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --service "$POSTGRES_SERVICE_ID" \
    --no-local \
    -- env \
      TRADEPING_BACKUP_MODE="$mode" \
      TRADEPING_REQUIRE_PUBLIC_DATABASE_URL=true \
      TRADEPING_REQUIRE_MATCHING_RAILWAY_DATABASE_URLS=true \
      TRADEPING_EXPECTED_PG_MAJOR="$EXPECTED_PG_MAJOR" \
      TRADEPING_EXPECTED_SOURCE_MB="$postgres_volume_size_mb" \
      TRADEPING_PG_CONNECT_TIMEOUT_SECONDS=10 \
      scripts/pg-backup.sh /dev/null "$BACKUP_DIR"
}

run_database_migrations() {
  railway run \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --service "$POSTGRES_SERVICE_ID" \
    --no-local \
    -- env \
      TRADEPING_BACKUP_MODE=ready \
      TRADEPING_REQUIRE_PUBLIC_DATABASE_URL=true \
      TRADEPING_REQUIRE_MATCHING_RAILWAY_DATABASE_URLS=true \
      TRADEPING_EXPECTED_PG_MAJOR="$EXPECTED_PG_MAJOR" \
      TRADEPING_EXPECTED_SOURCE_MB="$postgres_volume_size_mb" \
      TRADEPING_PG_CONNECT_TIMEOUT_SECONDS=10 \
    -- sh -eu -c '
      scripts/pg-backup.sh /dev/null "$1" >/dev/null
      : "${DATABASE_PUBLIC_URL:?DATABASE_PUBLIC_URL is required for local Railway migration execution}"
      export DATABASE_URL="$DATABASE_PUBLIC_URL"
      corepack pnpm db:deploy
      corepack pnpm --filter @tradeping/api exec prisma migrate status --schema ../../prisma/schema.prisma
    ' sh "$BACKUP_DIR"
}

assert_backup_outside_upload_context() {
  local repo_root backup_root
  repo_root="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
  backup_root="$(cd "$BACKUP_DIR" && pwd -P)" || \
    die "The backup directory cannot be resolved safely: $BACKUP_DIR"
  case "$backup_root/" in
    "$repo_root/"*)
      die "TRADEPING_BACKUP_DIR must resolve outside the Railway upload context ($repo_root)."
      ;;
  esac
}

verify_local_backup_artifact() {
  local backup_file="$1"
  local backup_dir backup_name checksum_name archive_mode checksum_mode directory_mode
  [[ -n "$backup_file" && -f "$backup_file" && ! -L "$backup_file" &&
     -f "$backup_file.sha256" && ! -L "$backup_file.sha256" ]] || \
    die "The verified backup archive or mandatory checksum sidecar is missing."
  backup_dir="$(dirname "$backup_file")"
  backup_name="$(basename "$backup_file")"
  checksum_name="$backup_name.sha256"
  [[ ! -L "$backup_dir" ]] || die "The backup directory became a symlink."
  if archive_mode="$(stat -f '%Lp' "$backup_file" 2>/dev/null)"; then
    checksum_mode="$(stat -f '%Lp' "$backup_file.sha256")"
    directory_mode="$(stat -f '%Lp' "$backup_dir")"
  else
    archive_mode="$(stat -c '%a' "$backup_file")"
    checksum_mode="$(stat -c '%a' "$backup_file.sha256")"
    directory_mode="$(stat -c '%a' "$backup_dir")"
  fi
  [[ "$archive_mode" == 600 && "$checksum_mode" == 600 && "$directory_mode" == 700 ]] || \
    die "Backup permissions changed; expected archive/checksum 600 and directory 700."
  if command -v shasum >/dev/null 2>&1; then
    (cd "$backup_dir" && shasum -a 256 --check "$checksum_name") >/dev/null || \
      die "The persisted backup checksum no longer matches $backup_file."
  elif command -v sha256sum >/dev/null 2>&1; then
    (cd "$backup_dir" && sha256sum --check "$checksum_name") >/dev/null || \
      die "The persisted backup checksum no longer matches $backup_file."
  else
    die "shasum or sha256sum disappeared after backup preflight."
  fi
}

wait_for_postgres_ready() {
  local started=$SECONDS
  until run_postgres_tool ready >&2; do
    if (( SECONDS - started >= READINESS_WAIT_SECONDS )); then
      die "Pinned PostgreSQL deployment did not accept SELECT 1 with the expected PG18 TradePing schema."
    fi
    sleep "$POLL_SECONDS"
  done
}

ensure_postgres_online() {
  local deployment_id inflight_id source_image
  source_image="$(service_source_image "$POSTGRES_SERVICE_ID")"
  if [[ "$source_image" == "$POSTGRES_IMAGE" ]]; then
    deployment_id="$(latest_success_with_digest "$POSTGRES_SERVICE_ID" "$POSTGRES_IMAGE_DIGEST")"
    if [[ -n "$deployment_id" ]] && \
       wait_for_deployment_success "$POSTGRES_SERVICE_ID" "$deployment_id" PostgreSQL \
         "$POSTGRES_IMAGE_DIGEST" "$POSTGRES_VOLUME_MOUNT" >/dev/null && \
       run_postgres_tool ready >&2; then
      note "Reusing exact healthy PostgreSQL deployment $deployment_id."
      printf '%s\n' "$deployment_id"
      return 0
    fi
    inflight_id="$(latest_inflight_with_digest "$POSTGRES_SERVICE_ID" "$POSTGRES_IMAGE_DIGEST")"
    if [[ -n "$inflight_id" ]]; then
      note "Resuming exact in-progress PostgreSQL deployment $inflight_id."
      wait_for_deployment_success "$POSTGRES_SERVICE_ID" "$inflight_id" PostgreSQL \
        "$POSTGRES_IMAGE_DIGEST" "$POSTGRES_VOLUME_MOUNT" >/dev/null
      postgres_volume_size_mb="$(assert_target_and_volume)"
      wait_for_postgres_ready
      printf '%s\n' "$inflight_id"
      return 0
    fi
  fi

  deployment_id="$(start_pinned_image_deployment "$POSTGRES_SERVICE_ID" "$POSTGRES_IMAGE" PostgreSQL)"
  wait_for_deployment_success "$POSTGRES_SERVICE_ID" "$deployment_id" PostgreSQL \
    "$POSTGRES_IMAGE_DIGEST" "$POSTGRES_VOLUME_MOUNT" >/dev/null
  assert_source_image "$POSTGRES_SERVICE_ID" "$POSTGRES_IMAGE" PostgreSQL
  postgres_volume_size_mb="$(assert_target_and_volume)"
  wait_for_postgres_ready
  printf '%s\n' "$deployment_id"
}

ensure_redis_online() {
  local redis_service_id="$1"
  local deployment_id inflight_id source_image
  source_image="$(service_source_image "$redis_service_id")"
  if [[ "$source_image" == "$REDIS_IMAGE" ]]; then
    deployment_id="$(latest_success_with_digest "$redis_service_id" "$REDIS_IMAGE_DIGEST")"
    if [[ -n "$deployment_id" ]]; then
      wait_for_deployment_success "$redis_service_id" "$deployment_id" Redis "$REDIS_IMAGE_DIGEST" >/dev/null
      note "Reusing exact Redis deployment $deployment_id."
      printf '%s\n' "$deployment_id"
      return 0
    fi
    inflight_id="$(latest_inflight_with_digest "$redis_service_id" "$REDIS_IMAGE_DIGEST")"
    if [[ -n "$inflight_id" ]]; then
      note "Resuming exact in-progress Redis deployment $inflight_id."
      wait_for_deployment_success "$redis_service_id" "$inflight_id" Redis "$REDIS_IMAGE_DIGEST" >/dev/null
      printf '%s\n' "$inflight_id"
      return 0
    fi
  fi
  deployment_id="$(start_pinned_image_deployment "$redis_service_id" "$REDIS_IMAGE" Redis)"
  wait_for_deployment_success "$redis_service_id" "$deployment_id" Redis "$REDIS_IMAGE_DIGEST" >/dev/null
  assert_source_image "$redis_service_id" "$REDIS_IMAGE" Redis
  printf '%s\n' "$deployment_id"
}

validate_remote_app_environment() {
  local api_service_id="$1"
  local require_recovery_values="${2:-false}"
  railway run \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --service "$api_service_id" \
    --no-local \
    -- node -e '
        const { validateEnv } = require("./apps/api/dist/config/env.js");
        try {
          const env = validateEnv(process.env);
          const base = new URL(env.APP_BASE_URL);
          if (env.APP_BASE_URL !== process.argv[1] || base.origin !== process.argv[1] ||
              base.pathname !== "/" || base.search || base.hash) {
            throw Object.assign(new Error("APP_BASE_URL"), { issues: [{ path: ["APP_BASE_URL"] }] });
          }
          if (process.argv[4] === "true" &&
              (env.RELEASE_SHA !== process.argv[2] || env.RECOVERY_SUPPRESS_BEFORE !== process.argv[3])) {
            const path = env.RELEASE_SHA !== process.argv[2] ? "RELEASE_SHA" : "RECOVERY_SUPPRESS_BEFORE";
            throw Object.assign(new Error(path), { issues: [{ path: [path] }] });
          }
        } catch (error) {
          const fields = [...new Set((error.issues ?? []).map((issue) => issue.path?.join(".") || "environment"))];
          console.error(`Invalid production API environment field(s): ${fields.join(", ") || "unknown"}. Secret values were not printed.`);
          process.exit(1);
        }
      ' "$API_ORIGIN" "$release_sha" "$CUTOFF" "$require_recovery_values"
}

set_api_variable() {
  local api_service_id="$1"
  local name="$2"
  local value="$3"
  printf '%s' "$value" | railway variable set \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --service "$api_service_id" \
    --stdin "$name" \
    --skip-deploys \
    --json >/dev/null
}

prepare_api_variables() {
  local api_service_id="$1"
  local name
  set_api_variable "$api_service_id" DATABASE_URL '${{Postgres.DATABASE_URL}}'
  set_api_variable "$api_service_id" REDIS_URL '${{Redis.REDIS_URL}}'
  set_api_variable "$api_service_id" RELEASE_SHA "$release_sha"
  set_api_variable "$api_service_id" RECOVERY_SUPPRESS_BEFORE "$CUTOFF"

  if [[ -n "$ENV_FILE" ]]; then
    local keys=(
      NODE_ENV PORT APP_BASE_URL TELEGRAM_BOT_TOKEN TELEGRAM_BOT_USERNAME
      TELEGRAM_WEBHOOK_SECRET SNAPTRADE_CLIENT_ID SNAPTRADE_CONSUMER_KEY
      SNAPTRADE_REDIRECT_URI SNAPTRADE_BROKER_SLUG SNAPTRADE_USE_MOCK
      ENCRYPTION_KEY_BASE64 INTERNAL_JOB_SECRET TRADE_ORDER_LOOKBACK_DAYS
      SYNC_INTERVAL_MINUTES BACKFILL_SUPPRESS_HOURS
    )
    for name in "${keys[@]}"; do
      if [[ -n "${!name:-}" ]]; then
        set_api_variable "$api_service_id" "$name" "${!name}"
      fi
    done
  fi
}

create_missing_api_service() {
  local before_ids new_service_info new_id
  assert_ambient_target_for_add
  before_ids="$(railway_services_json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => process.stdout.write(JSON.stringify(JSON.parse(input).map((item) => item.id))));
  ')"
  railway add --service "$API_SERVICE_NAME" --json >/dev/null
  new_service_info="$(railway_services_json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const before = new Set(JSON.parse(process.argv[1]));
      const created = JSON.parse(input).filter((item) => !before.has(item.id));
      if (created.length !== 1 || created[0].name !== process.argv[2] || created[0].source) process.exit(1);
      process.stdout.write(created[0].id);
    });
  ' "$before_ids" "$API_SERVICE_NAME")" || die "Could not uniquely identify the new source-less API service."
  new_id="$new_service_info"
  if [[ "$REPLACEMENT_API_SERVICE_ID" != "$new_id" ]]; then
    die "Created source-less API service $new_id. No data cleanup occurred. Attach the canonical $API_ORIGIN hostname, then rerun with TRADEPING_REPLACEMENT_API_SERVICE_ID=$new_id and its reviewed TRADEPING_REPLACEMENT_API_DOMAIN_ID."
  fi
  printf '%s\n' "$new_id"
}

create_missing_redis_service() {
  local before_ids new_id
  assert_ambient_target_for_add
  before_ids="$(railway_services_json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => process.stdout.write(JSON.stringify(JSON.parse(input).map((item) => item.id))));
  ')"
  railway add --database redis --json >/dev/null
  new_id="$(railway_services_json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const before = new Set(JSON.parse(process.argv[1]));
      const created = JSON.parse(input).filter((item) => !before.has(item.id));
      if (created.length !== 1 || created[0].name !== process.argv[2]) process.exit(1);
      process.stdout.write(created[0].id);
    });
  ' "$before_ids" "$REDIS_SERVICE_NAME")" || die "Could not uniquely identify the replacement Redis service."
  if [[ "$REPLACEMENT_REDIS_SERVICE_ID" != "$new_id" ]]; then
    die "Created replacement Redis service $new_id. No data cleanup occurred. Rerun with TRADEPING_REPLACEMENT_REDIS_SERVICE_ID=$new_id after reviewing it."
  fi
  printf '%s\n' "$new_id"
}

run_recovery_cleanup() {
  local confirmation="skip-and-clean-$RECOVERY_RUN_ID-before-$CUTOFF"
  railway run \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --service "$POSTGRES_SERVICE_ID" \
    --no-local \
    -- env \
      TRADEPING_CLEANUP_CONFIRM="$confirmation" \
      TRADEPING_RECOVERY_RUN_ID="$RECOVERY_RUN_ID" \
      TRADEPING_RECOVERY_RELEASE_SHA="$release_sha" \
      TRADEPING_REQUIRE_PUBLIC_DATABASE_URL=true \
      TRADEPING_REQUIRE_MATCHING_RAILWAY_DATABASE_URLS=true \
      TRADEPING_EXPECTED_PG_MAJOR="$EXPECTED_PG_MAJOR" \
      TRADEPING_PG_CONNECT_TIMEOUT_SECONDS=10 \
      scripts/recovery-cleanup.sh "$CUTOFF" /dev/null "$RECOVERY_RUN_ID" "$release_sha"
}

newest_deployment_is() {
  local service_id="$1"
  local deployment_id="$2"
  railway_deployments_json "$service_id" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const deployments = JSON.parse(input);
      process.exit(deployments[0]?.id === process.argv[1] ? 0 : 1);
    });
  ' "$deployment_id"
}

api_fail_closed_armed=false
api_deployment_id=''
api_service_id=''
api_before_ids=''
fail_closed_on_exit() {
  local result=$?
  if (( result != 0 )) && [[ "$api_fail_closed_armed" == true && -n "$api_service_id" ]]; then
    set +e
    if [[ -z "$api_deployment_id" && -n "$api_before_ids" ]]; then
      api_deployment_id="$(new_deployment_once "$api_service_id" "$api_before_ids" 2>/dev/null || true)"
    fi
    if [[ -n "$api_deployment_id" ]] && newest_deployment_is "$api_service_id" "$api_deployment_id"; then
      note "Verification failed; removing exact newest API deployment $api_deployment_id to fail closed."
      railway down \
        --project "$PROJECT_ID" \
        --environment "$ENVIRONMENT_ID" \
        --service "$api_service_id" \
        --yes >/dev/null
    elif [[ -n "$api_deployment_id" ]]; then
      note "Verification failed, but a newer API deployment exists. Refusing to remove an unverified concurrent deployment automatically."
    else
      note "Verification failed before one API deployment could be identified; inspect the source-less API service and keep it offline."
    fi
    set -e
  fi
  exit "$result"
}
trap fail_closed_on_exit EXIT

validate_health_body() {
  local body="$1"
  local expected_deployment_id="$2"
  node -e '
    let body;
    try { body = JSON.parse(process.argv[1]); } catch { process.exit(1); }
    const valid = body.ok === true && body.service === "tradeping-api" &&
      body.release === process.argv[2] && body.deploymentId === process.argv[3] &&
      body.checks?.database === "up" && body.checks?.redis === "up";
    process.exit(valid ? 0 : 1);
  ' "$body" "$release_sha" "$expected_deployment_id"
}

wait_for_exact_health() {
  local expected_deployment_id="$1"
  local started=$SECONDS
  local body=''
  while (( SECONDS - started < HEALTH_WAIT_SECONDS )); do
    if body="$(curl \
      --fail \
      --silent \
      --show-error \
      --connect-timeout 5 \
      --max-time 10 \
      --header 'Accept: application/json' \
      --header 'Cache-Control: no-cache' \
      "$API_ORIGIN/healthz?deployment=$expected_deployment_id" 2>/dev/null)" && validate_health_body "$body" "$expected_deployment_id"; then
      note "Exact API release and deployment are healthy with PostgreSQL and Redis up."
      return 0
    fi
    sleep "$POLL_SECONDS"
  done
  return 1
}

verify_telegram_webhook() {
  local api_service_id="$1"
  local deployment_created_at="$2"
  local started=$SECONDS
  while (( SECONDS - started < WEBHOOK_WAIT_SECONDS )); do
    if railway run \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --service "$api_service_id" \
    --no-local \
    -- env \
      EXPECTED_TELEGRAM_WEBHOOK_URL="$API_ORIGIN/telegram/webhook" \
      VERIFIED_DEPLOYMENT_CREATED_AT="$deployment_created_at" \
      node -e '
        (async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          let response;
          try {
            response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`, {
              signal: controller.signal,
              headers: { accept: "application/json" }
            });
          } finally {
            clearTimeout(timeout);
          }
          if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
          const payload = await response.json();
          const result = payload.result ?? {};
          if (!payload.ok || result.url !== process.env.EXPECTED_TELEGRAM_WEBHOOK_URL) {
            throw new Error("Telegram webhook is not registered to the pinned API URL");
          }
          if (result.max_connections !== 1) {
            throw new Error("Telegram webhook max_connections is not the required serialized value 1");
          }
          const allowedUpdates = new Set(Array.isArray(result.allowed_updates) ? result.allowed_updates : []);
          if (!allowedUpdates.has("message") || !allowedUpdates.has("my_chat_member")) {
            throw new Error("Telegram webhook does not include both message and my_chat_member updates");
          }
          const deploymentSeconds = Math.floor(Date.parse(process.env.VERIFIED_DEPLOYMENT_CREATED_AT) / 1000);
          const errorSeconds = Number(result.last_error_date);
          if (result.last_error_message && (!Number.isFinite(errorSeconds) || errorSeconds >= deploymentSeconds)) {
            throw new Error("Telegram reports a webhook error at or after this deployment");
          }
          if (result.last_error_message) {
            console.warn("Telegram retains a historical pre-deployment webhook error; exact URL is registered.");
          }
          console.log(`Telegram webhook verified; pending updates preserved: ${Number(result.pending_update_count) || 0}.`);
        })().catch((error) => {
          console.error(`Telegram webhook verification failed: ${error.message}`);
          process.exit(1);
        });
      '; then
      return 0
    fi
    sleep "$POLL_SECONDS"
  done
  return 1
}

echo "== TradePing Railway recovery preflight =="
for command_name in railway node git curl corepack; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required."
done
require_positive_integer TRADEPING_NEW_DEPLOYMENT_WAIT_SECONDS "$NEW_DEPLOYMENT_WAIT_SECONDS"
require_positive_integer TRADEPING_DEPLOYMENT_WAIT_SECONDS "$DEPLOYMENT_WAIT_SECONDS"
require_positive_integer TRADEPING_READINESS_WAIT_SECONDS "$READINESS_WAIT_SECONDS"
require_positive_integer TRADEPING_HEALTH_WAIT_SECONDS "$HEALTH_WAIT_SECONDS"
require_positive_integer TRADEPING_WEBHOOK_WAIT_SECONDS "$WEBHOOK_WAIT_SECONDS"
require_positive_integer TRADEPING_POLL_SECONDS "$POLL_SECONDS"
[[ "$PREFLIGHT_ONLY" == true || "$PREFLIGHT_ONLY" == false ]] || \
  die "TRADEPING_RECOVERY_PREFLIGHT_ONLY must be true or false."

railway_version="$(railway --version | awk '{print $2}')"
node -e '
  const parse = (value) => value.split(".").map(Number);
  const actual = parse(process.argv[1]);
  const minimum = parse(process.argv[2]);
  const atLeastMinimum = actual[1] > minimum[1] ||
    (actual[1] === minimum[1] && actual[2] >= minimum[2]);
  const valid = actual.length === 3 && actual.every(Number.isInteger) && actual[0] === 5 && atLeastMinimum;
  process.exit(valid ? 0 : 1);
' "$railway_version" "$MIN_RAILWAY_CLI_VERSION" || \
  die "Railway CLI must be version $MIN_RAILWAY_CLI_VERSION or a newer 5.x release (found $railway_version)."
railway whoami >/dev/null

[[ -n "$CUTOFF" ]] && canonical_utc_timestamp "$CUTOFF" || \
  die "RECOVERY_SUPPRESS_BEFORE must be one stable canonical UTC timestamp such as 2026-08-11T14:30:00.000Z."
[[ "$RECOVERY_RUN_ID" =~ ^[A-Za-z0-9._-]{8,100}$ ]] || \
  die "RECOVERY_RUN_ID must be 8-100 characters using only letters, numbers, dot, underscore, or hyphen."
expected_recovery_confirmation="restore-$RECOVERY_RUN_ID-before-$CUTOFF"
[[ "$RECOVERY_CONFIRM" == "$expected_recovery_confirmation" ]] || \
  die "Set TRADEPING_RECOVERY_CONFIRM=$expected_recovery_confirmation to authorize this exact recovery contract."
for replacement_id in "$REPLACEMENT_API_SERVICE_ID" "$REPLACEMENT_API_DOMAIN_ID" "$REPLACEMENT_REDIS_SERVICE_ID"; do
  [[ -z "$replacement_id" ]] || valid_uuid "$replacement_id" || \
    die "Replacement Railway IDs must be lowercase UUIDs."
done

[[ -z "$(git status --porcelain)" ]] || die "Refusing recovery from a dirty worktree. Commit and verify the release first."
[[ "$(git branch --show-current)" == "$RELEASE_BRANCH" ]] || \
  die "Refusing recovery from branch $(git branch --show-current); expected $RELEASE_BRANCH."
[[ "$(git remote get-url origin)" == "$ORIGIN_URL" ]] || \
  die "Git origin must be exactly $ORIGIN_URL."
git fetch --quiet --no-tags origin "$RELEASE_BRANCH"
release_sha="$(git rev-parse HEAD)"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || die "Could not resolve a full release SHA."
[[ "$release_sha" == "$(git rev-parse "origin/$RELEASE_BRANCH")" ]] || \
  die "Local HEAD is not the exact origin/$RELEASE_BRANCH release."

postgres_volume_size_mb="$(assert_target_and_volume)"
assert_single_project_environment
postgres_service_id="$(service_id_by_name "$POSTGRES_SERVICE_NAME")"
[[ "$postgres_service_id" == "$POSTGRES_SERVICE_ID" ]] || die "Pinned Postgres service ID/name mismatch."
api_service_id="$(service_id_by_name "$API_SERVICE_NAME")"
redis_service_id="$(service_id_by_name "$REDIS_SERVICE_NAME")"
if [[ -n "$api_service_id" ]]; then
  assert_service_identity "$API_SERVICE_NAME" "$api_service_id" "$HISTORICAL_API_SERVICE_ID" "$REPLACEMENT_API_SERVICE_ID"
  assert_api_offline "$api_service_id"
  assert_api_domain "$api_service_id"
  assert_api_source_less "$api_service_id"
elif [[ -z "$ENV_FILE" ]]; then
  die "The API service is missing; an explicit production env file is required before creating a source-less replacement."
fi
if [[ -n "$redis_service_id" ]]; then
  assert_service_identity "$REDIS_SERVICE_NAME" "$redis_service_id" "$REDIS_SERVICE_ID" "$REPLACEMENT_REDIS_SERVICE_ID"
fi

if [[ -n "$ENV_FILE" ]]; then
  [[ "$ENV_FILE" != '.env' && -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || \
    die "The explicit production env file must exist, must not be .env, and must not be a symlink."
  note "Loading explicitly supplied production variables from $ENV_FILE (values will not be printed)."
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

note "Building the exact release so the application-owned environment schema can run."
corepack pnpm --filter @tradeping/api build >/dev/null
[[ -z "$(git status --porcelain)" ]] || die "The release build changed tracked or untracked source files; refusing to upload a workspace that no longer matches Git HEAD."
if [[ -n "$ENV_FILE" ]]; then
  env \
    DATABASE_URL='postgresql://preflight:preflight@127.0.0.1:5432/tradeping' \
    REDIS_URL='redis://:preflight@127.0.0.1:6379' \
    RELEASE_SHA="$release_sha" \
    RAILWAY_DEPLOYMENT_ID='00000000-0000-4000-8000-000000000000' \
    RECOVERY_SUPPRESS_BEFORE="$CUTOFF" \
    node -e '
      const { validateEnv } = require("./apps/api/dist/config/env.js");
      try {
        const env = validateEnv(process.env);
        const base = new URL(env.APP_BASE_URL);
        if (env.APP_BASE_URL !== process.argv[1] || base.origin !== process.argv[1] ||
            base.pathname !== "/" || base.search || base.hash) {
          throw Object.assign(new Error("APP_BASE_URL"), { issues: [{ path: ["APP_BASE_URL"] }] });
        }
      } catch (error) {
        const fields = [...new Set((error.issues ?? []).map((issue) => issue.path?.join(".") || "environment"))];
        console.error(`Invalid production API environment field(s): ${fields.join(", ") || "unknown"}. Secret values were not printed.`);
        process.exit(1);
      }
    ' "$API_ORIGIN"
else
  validate_remote_app_environment "$api_service_id" false
fi

# Local Railway runs cannot resolve *.railway.internal. This validates that the
# Postgres service exposes its own public URL, all PG18 tools are present, and
# the backup destination has enough free space before any production mutation.
run_postgres_tool preflight
assert_backup_outside_upload_context

echo "Project/environment: $PROJECT_ID / $ENVIRONMENT_ID"
echo "Release: $release_sha"
echo "Recovery run: $RECOVERY_RUN_ID"
echo "Recovery cutoff: $CUTOFF"
echo "Pinned volume: $POSTGRES_VOLUME_ID at $POSTGRES_VOLUME_MOUNT (${postgres_volume_size_mb} MB used)"
if [[ "$PREFLIGHT_ONLY" == true ]]; then
  echo "Recovery preflight complete. TRADEPING_RECOVERY_PREFLIGHT_ONLY=true; no production mutation was attempted."
  trap - EXIT
  exit 0
fi

echo "== Starting pinned PostgreSQL 18 and waiting for exact readiness =="
postgres_deployment_id="$(ensure_postgres_online)"
postgres_volume_size_mb="$(assert_target_and_volume)"
echo "PostgreSQL deployment: $postgres_deployment_id"

echo "== Creating checksum-protected pre-migration PostgreSQL backup =="
backup_output="$(run_postgres_tool backup)"
printf '%s\n' "$backup_output"
verified_backup_file="$(printf '%s\n' "$backup_output" | awk '
  /^BACKUP_FILE=/ {
    sub(/^BACKUP_FILE=/, "");
    print;
    exit;
  }
')"
verify_local_backup_artifact "$verified_backup_file"
assert_backup_outside_upload_context

echo "== Applying the exact release migrations while the API remains offline =="
run_database_migrations
run_postgres_tool ready >/dev/null

if [[ -z "$redis_service_id" ]]; then
  echo "== Creating replacement Redis service =="
  redis_service_id="$(create_missing_redis_service)"
fi
assert_service_identity "$REDIS_SERVICE_NAME" "$redis_service_id" "$REDIS_SERVICE_ID" "$REPLACEMENT_REDIS_SERVICE_ID"
echo "== Starting Redis from the pinned historical digest =="
redis_deployment_id="$(ensure_redis_online "$redis_service_id")"
echo "Redis deployment: $redis_deployment_id"

if [[ -z "$api_service_id" ]]; then
  echo "== Creating source-less API service =="
  api_service_id="$(create_missing_api_service)"
fi
assert_service_identity "$API_SERVICE_NAME" "$api_service_id" "$HISTORICAL_API_SERVICE_ID" "$REPLACEMENT_API_SERVICE_ID"

echo "== Setting validated API variables before uploading code =="
prepare_api_variables "$api_service_id"
assert_api_domain "$api_service_id"
assert_api_source_less "$api_service_id"
validate_remote_app_environment "$api_service_id" true
assert_api_offline "$api_service_id"
newest_deployment_is "$POSTGRES_SERVICE_ID" "$postgres_deployment_id" || \
  die "A concurrent PostgreSQL deployment appeared after the verified backup."
wait_for_deployment_success "$POSTGRES_SERVICE_ID" "$postgres_deployment_id" PostgreSQL \
  "$POSTGRES_IMAGE_DIGEST" "$POSTGRES_VOLUME_MOUNT" >/dev/null
postgres_volume_size_mb="$(assert_target_and_volume)"
run_postgres_tool ready >/dev/null
verify_local_backup_artifact "$verified_backup_file"
newest_deployment_is "$redis_service_id" "$redis_deployment_id" || \
  die "A concurrent Redis deployment appeared before recovery cleanup."
wait_for_deployment_success "$redis_service_id" "$redis_deployment_id" Redis "$REDIS_IMAGE_DIGEST" >/dev/null

[[ -z "$(git status --porcelain)" && "$(git rev-parse HEAD)" == "$release_sha" ]] || \
  die "The workspace changed after preflight; refusing recovery cleanup and upload."

echo "== Recording the durable recovery contract and neutralizing only unsent pre-cutoff alerts =="
run_recovery_cleanup

echo "== Uploading exact API release $release_sha =="
[[ -z "$(git status --porcelain)" && "$(git rev-parse HEAD)" == "$release_sha" ]] || \
  die "The workspace changed after cleanup. The cleanup is retry-safe; restore the exact clean release before rerunning."
api_before_ids="$(deployment_ids_json "$api_service_id")"
api_fail_closed_armed=true
if ! railway up . \
  --project "$PROJECT_ID" \
  --environment "$ENVIRONMENT_ID" \
  --service "$api_service_id" \
  --detach \
  --yes \
  --json \
  --message "recover $RECOVERY_RUN_ID release $release_sha" >/dev/null; then
  api_deployment_id="$(new_deployment_once "$api_service_id" "$api_before_ids" 2>/dev/null || true)"
  die "The API upload command failed. Any uniquely identified deployment will be removed to fail closed."
fi
if ! api_deployment_id="$(wait_for_new_deployment "$api_service_id" "$api_before_ids" API)"; then
  api_deployment_id="$(new_deployment_once "$api_service_id" "$api_before_ids" 2>/dev/null || true)"
  die "The API upload did not create exactly one identifiable new deployment."
fi
api_deployment_created_at="$(wait_for_deployment_success "$api_service_id" "$api_deployment_id" API)"
newest_deployment_is "$api_service_id" "$api_deployment_id" || \
  die "A concurrent API deployment superseded exact deployment $api_deployment_id."
assert_api_domain "$api_service_id"

echo "== Waiting for exact API deployment health =="
wait_for_exact_health "$api_deployment_id" || \
  die "Exact API deployment $api_deployment_id did not become healthy on the pinned domain."
newest_deployment_is "$api_service_id" "$api_deployment_id" || \
  die "A concurrent API deployment appeared during health verification."

echo "== Verifying Telegram webhook without dropping queued updates =="
verify_telegram_webhook "$api_service_id" "$api_deployment_created_at" || \
  die "Telegram webhook did not reach the exact serialized recovery configuration."
newest_deployment_is "$api_service_id" "$api_deployment_id" || \
  die "A concurrent API deployment appeared during Telegram verification."
assert_api_domain "$api_service_id"

api_fail_closed_armed=false
trap - EXIT
echo "Recovery complete for run $RECOVERY_RUN_ID, release $release_sha, deployment $api_deployment_id."
echo "Verified pre-migration backup retained at $verified_backup_file (checksum: $verified_backup_file.sha256)."
