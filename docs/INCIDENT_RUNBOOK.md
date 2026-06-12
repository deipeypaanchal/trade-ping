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
  "release": "9c49eaa",
  "checks": {
    "database": "up",
    "redis": "up"
  }
}
```

Use `release` to confirm the expected commit is running. Use `startedAt` and
`uptimeSeconds` to identify crash loops or unexpected restarts.

## Trade Did Not Ping

Ask for:

- Telegram group name.
- Telegram member display name.
- Broker name only. Do not ask for account numbers.
- Approximate execution time and symbol.
- Whether `/status` and `/diagnostics` were run in the group.

Then inspect:

```sql
-- group/user setup
SELECT g.name, u."displayName", gm."privacyLevel", gm."alertsEnabled"
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
| Privacy `OFF` or `alertsEnabled = false` | User opted out in this group. | User runs `/privacy normal` or desired level. |
| Connection `DISABLED` or `ERROR` | Broker auth needs repair. | User runs `/reconnect` in the group. |

## Railway Recovery

When Railway quota resets or billing is fixed:

```bash
corepack pnpm railway:recover .env.production.local
corepack pnpm db:backup .env.production.local
curl -fsS https://api-production-4bc3.up.railway.app/healthz
```

The recovery script preserves Postgres, recreates Redis/API when needed, sets
`RELEASE_SHA`, deploys, and polls health.

## Never Do First

- Do not delete the Postgres volume as a first response. That forces every user
  to reauthenticate and relink brokerages.
- Do not post raw Railway variables, Telegram tokens, SnapTrade keys, database
  URLs, or webhook payloads in GitHub issues.
- Do not promise real-time delivery for brokers with delayed feeds.
