# TradePing Incident Runbook

Use this when someone says "the bot is down" or "my trade did not ping."

## First Five Minutes

1. Check public health:

   ```bash
   curl -fsS https://api-production-4bc3.up.railway.app/healthz
   curl -fsS https://api-production-4bc3.up.railway.app/livez
   ```

2. Interpret the result:

   - `200` from `/healthz`: API, Postgres, and Redis are reachable. Investigate
     broker freshness, queue backlog, or user/group settings.
   - `503` from `/healthz` but `200` from `/livez`: container is alive, but
     Postgres or Redis is down. Read the `checks` object.
   - `404` or connection failure: API service is not serving this app. Check
     Railway service/deployment state.

3. Check Railway:

   ```bash
   railway status
   railway service list --json
   railway logs --service api --lines 300
   railway volume list --json
   ```

4. If Railway says `You have used all your available resources`, stop deploying
   until quota resets or billing/usage is raised. Do not wipe Postgres.

## Dependency Triage

`/healthz` returns:

```json
{
  "ok": true,
  "service": "tradeping-api",
  "time": "2026-06-12T12:00:00.000Z",
  "startedAt": "2026-06-12T11:55:00.000Z",
  "uptimeSeconds": 300,
  "release": "9c49eaa2db4088600aad6a60a42119c85bcb23cf",
  "deploymentId": "019c92ba-3e22-7c2a-a57c-89f03b330a51",
  "checks": {
    "database": "up",
    "redis": "up"
  }
}
```

Use the full `release` and `deploymentId` together to confirm the expected
commit and exact Railway deployment are running. Use `startedAt` and
`uptimeSeconds` to identify crash loops or unexpected restarts.

## Trade Did Not Ping

Ask for:

- Telegram group name.
- Telegram member display name.
- Broker name only. Do not ask for account numbers.
- Approximate execution time and symbol.
- Whether `/status` and `/diagnostics` were run in the group. Their detailed
  results are sent to that member's DM; do not ask them to paste private details
  into the group.

Then inspect:

```sql
-- group/user setup
SELECT g.name, u."displayName", u."brokerSyncEnabled", u."deletionPendingAt",
       gm."privacyLevel", gm."alertsEnabled", gm."sharingEnabledAt"
FROM "GroupMember" gm
JOIN "Group" g ON g.id = gm."groupId"
JOIN "User" u ON u.id = gm."userId"
ORDER BY gm."updatedAt" DESC
LIMIT 50;

-- recent detected trades
SELECT "symbol", "side", "tradeTime", "createdAt", "alertStatus",
       "backfillStatus", "rawType", "rawStatus", "priceSource"
FROM "TradeEvent"
ORDER BY "tradeTime" DESC
LIMIT 50;

-- recent sync and worker failures
SELECT action, metadata, "createdAt"
FROM "AuditLog"
ORDER BY "createdAt" DESC
LIMIT 100;
```

Common outcomes:

| Symptom | Meaning | Action |
| --- | --- | --- |
| No `TradeEvent` exists | SnapTrade has not reported the trade yet, or the broker feed is delayed. | Run `/diagnostics`; wait for delayed brokers like Fidelity/IBKR. |
| `TradeEvent.alertStatus = PENDING` | Detected but not delivered. | Check Redis/worker logs and `job_failed` audit rows. |
| `backfillStatus = BACKFILL` | Older broker history was recorded but not replayed. | No user-facing action unless this was a fresh trade misclassified. |
| `rawType = position_delta` and `SKIPPED` | Holdings-only change was intentionally diagnostic-only. | Broker-confirmed order feed did not provide execution details. |
| `privacyLevel = OFF`, `alertsEnabled = false`, or `sharingEnabledAt IS NULL` | Sharing was never explicitly enabled here, or was later disabled. | User explicitly runs `/privacy public`, `/privacy normal`, or `/privacy private` in this group. Only later executions are eligible. |
| `TradeEvent.tradeTime <= GroupMember.sharingEnabledAt` | The execution does not provably follow explicit consent for this group. | No action; it must remain unposted. Wait for a later execution rather than moving the consent boundary backward. |
| `brokerSyncEnabled = false` and `deletionPendingAt IS NULL` | The durable user-level gate was disabled by global disconnect. | Do not force a sync. The user must reconnect and make a fresh `/privacy` choice if they intend to return. |
| `deletionPendingAt IS NOT NULL` | Account deletion has begun and reconnect/consent is permanently blocked for this record. | Never force sync or reconnect. Follow the deletion lifecycle below. |
| Connection `DISABLED` or `ERROR` | Broker auth needs repair. | User runs `/reconnect` in the group. |

## Account Deletion Is Pending

`DELETE /account/delete` scrubs user content and the Telegram identifier before
the provider call. A provider-backed response with `deleted: false`,
`pending: true`, and `remoteDeletionAccepted: true` means SnapTrade accepted an
asynchronous request; it does not mean deletion is confirmed. Store the opaque
`deletionRequestId` in the private support case because the Telegram identifier
can no longer locate the record.

Inspect lifecycle state without selecting the provider user id:

```sql
SELECT pd."localUserId", pd.purpose, pd.status, pd."requestedAt",
       pd."lastAttemptAt", pd."lastError", u."deletionPendingAt",
       u."deletionBlockReason"
FROM "ProviderDeletion" pd
LEFT JOIN "User" u ON u.id = pd."localUserId"
WHERE pd.purpose = 'ACCOUNT_DELETION'
ORDER BY pd."updatedAt" DESC
LIMIT 50;
```

- `READY`: the provider call failed or has not been accepted. The retry service
  runs at startup and hourly. To request an immediate retry, call
  `DELETE /account/delete` with `{"userId":"<deletionRequestId>"}` and the
  internal bearer token.
- `PENDING`: accepted but unconfirmed. Do not declare completion. Requests older
  than 24 hours are retried automatically in case acceptance or confirmation
  was lost.
- A signed `USER_DELETED` webhook, or an authoritative provider `404` returned
  while retrying deletion of the exact generation-scoped identity, removes the
  minimal local user and tombstone; a later lookup by the request id then
  returns `notFound: true`.
- `manualReviewRequired: true` or `deletionBlockReason = MISSING_PROVIDER_ID`
  means the content and Telegram identity were scrubbed but no safe remote user
  id exists. Escalate for provider/operator resolution.

Never delete the minimal user or `ProviderDeletion` row manually while remote
deletion is unconfirmed: those records are the only durable retry and
confirmation handles. Never restore the Telegram identifier, credentials,
syncing, or group sharing to make a retry easier.

## Post-Cutover Privacy Audit

For the explicit-consent/deletion-lifecycle release, keep the old API and
workers drained through migration and cutover. From the exact release checkout,
confirm Prisma sees no pending migration, then run these read-only invariants
against the production public Postgres URL:

```bash
DATABASE_URL="$DATABASE_PUBLIC_URL" \
  corepack pnpm --filter @tradeping/api exec prisma migrate status \
  --schema ../../prisma/schema.prisma

PGOPTIONS='-c statement_timeout=30000 -c lock_timeout=5000' \
psql "$DATABASE_PUBLIC_URL" --no-psqlrc --no-password \
  --set=ON_ERROR_STOP=1 <<'SQL'
BEGIN TRANSACTION READ ONLY;

SELECT count(*) AS invalid_explicit_consent_rows
FROM "GroupMember"
WHERE NOT (
  ("alertsEnabled" = false AND "sharingEnabledAt" IS NULL)
  OR
  ("alertsEnabled" = true AND "privacyLevel" <> 'OFF' AND "sharingEnabledAt" IS NOT NULL)
);

SELECT count(*) AS unsafe_unsent_group_events
FROM "TradeEvent" te
WHERE te."groupId" IS NOT NULL
  AND te."alertStatus" IN ('PENDING', 'SENDING')
  AND NOT EXISTS (
    SELECT 1
    FROM "GroupMember" gm
    WHERE gm."userId" = te."userId"
      AND gm."groupId" = te."groupId"
      AND gm."alertsEnabled" = true
      AND gm."privacyLevel" <> 'OFF'
      AND gm."sharingEnabledAt" IS NOT NULL
      AND te."tradeTime" > gm."sharingEnabledAt"
  );

SELECT count(*) AS legacy_raw_provider_ids
FROM "AuditLog"
WHERE action = 'snaptrade_webhook_received'
  AND metadata ? 'userId';

COMMIT;
SQL
```

All three counts must be `0`. A nonzero value is a fail-closed cutover blocker:
keep the API offline, preserve the pre-migration backup, and investigate before
allowing Telegram or worker traffic. Do not “fix” the result by enabling a
membership or changing a consent timestamp.

## Railway Recovery

When Railway quota resets or billing is fixed, choose one canonical UTC cutoff
for the incident and reuse the exact timestamp on every retry:

```bash
cp .env.example .env.production.local
# Restore production values from the private secret manager.
RECOVERY_RUN_ID=tradeping-20260811-outage \
RECOVERY_SUPPRESS_BEFORE=2026-08-11T14:30:00.000Z \
TRADEPING_RECOVERY_CONFIRM=restore-tradeping-20260811-outage-before-2026-08-11T14:30:00.000Z \
  corepack pnpm railway:recover .env.production.local
```

Use the identical contract with `TRADEPING_RECOVERY_PREFLIGHT_ONLY=true` to run
all read-only checks and exit before the first production mutation. This mode
still requires the stable run ID, cutoff, confirmation, clean exact release,
and pinned Railway identities.

Run recovery only from a clean `main` whose HEAD exactly matches `origin/main`.
Reuse the same run ID, cutoff, and release commit on every retry. The script
pins the exact Git/Railway project, environment, service, domain, and existing
non-empty `READY` Postgres volume identities. After all local/environment/API
offline preflights pass, it starts that service from the checked-in historical
Postgres 18 digest, waits for the exact deployment and `SELECT 1`, and rechecks
the original volume. It then creates a restricted custom-format backup,
full-reads it with `pg_restore`, and verifies its mandatory SHA-256 sidecar
before cleanup, migrations, or API upload can proceed.

Cleanup marks only pre-cutoff `PENDING`/`SENDING` events as
`BACKFILL`/`SKIPPED`. It preserves sent `TradeEvent` history and rendered alert
receipts. PostgreSQL records an immutable run-ID/cutoff/full-release contract,
so an identical retry is safe and a changed contract is rejected. Recovery
pins Redis, keeps the API source-less and offline through cleanup, stores
validated variables before upload, and polls the one deployment created by the
upload. The pinned domain must report the full release SHA, that exact Railway
deployment ID, and Postgres/Redis up. Telegram's URL must match that domain;
post-deployment webhook errors fail verification, historical errors are
reported, queued updates are never dropped, and webhook verification requires
`max_connections: 1` plus both `message` and `my_chat_member` updates so
consent/removal delivery remains serialized.

## Never Do First

- Do not delete the Postgres volume as a first response. That forces every user
  to reauthenticate and relink brokerages.
- Do not change `RECOVERY_RUN_ID`, `RECOVERY_SUPPRESS_BEFORE`, or the release
  commit between retries, and do not invent a cutoff from wall-clock time.
- Do not redeploy Postgres from a mutable source image before the verified
  pre-migration backup exists.
- Do not delete sent alert rows during cleanup; they are delivery history and
  dedupe evidence.
- Do not register the Telegram webhook with `drop_pending_updates`. A queued
  `/privacy off` or `/disconnect` request must survive a restart.
- Do not post raw Railway variables, Telegram tokens, SnapTrade keys, database
  URLs, or webhook payloads in GitHub issues.
- Do not promise real-time delivery for brokers with delayed feeds.
