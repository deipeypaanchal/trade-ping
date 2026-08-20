# TradePing — End-to-End Deployment Guide

Audience: the person who deploys, operates, and keeps this bot alive.
Scope: zero-to-live, plus day-2 operations. Follow top to bottom on first deploy.

> If you only have 10 minutes, skip to [Quick path: Railway](#quick-path-railway-recommended).

---

## 0. What you are deploying

A single NestJS HTTP service (`@tradeping/api`) that:

- Listens for Telegram bot updates at `POST /telegram/webhook`.
- Listens for SnapTrade events at `POST /snaptrade/webhook`.
- Hosts an internal `POST /jobs/...` API for scheduled syncs.
- Runs an in-process BullMQ worker that talks to SnapTrade and posts Telegram alerts.
- Health check: `GET /healthz` verifies Postgres and Redis.

Dependencies it requires at runtime:

| Dependency | Purpose | Production recommendation |
| --- | --- | --- |
| Postgres 14+ | All persistent state (users, connections, trade events, alerts, audit logs) | Managed (Railway / Neon / RDS). Private network. |
| Redis 6+ | BullMQ queue for sync jobs | Managed (Railway / Upstash / Elasticache). `rediss://` (TLS). |
| Telegram Bot API | Inbound commands + outbound alerts | Free. |
| SnapTrade API | Brokerage data | Paid account. Free tier works for testing. |

Estimated monthly cost for 20 users: ~$5–$20 (Railway Postgres + Redis + service) + SnapTrade plan.

---

## 1. Prerequisites — accounts and tooling

Before touching infra, create these accounts:

1. **Telegram bot** via [@BotFather](https://t.me/botfather):
   - `/newbot` → name → username (must end in `bot`).
   - Copy the **bot token** (`123456789:AA…`). Treat as a secret.
   - `/setprivacy` → **Disable**. Required so the bot can read `/connect`, `/sync`, etc. from group messages. Without this the bot only sees messages explicitly mentioning it.
   - `/setjoingroups` → **Enable**.
   - Optional: `/setdescription`, `/setabouttext`, `/setuserpic` for polish.
2. **SnapTrade**: <https://dashboard.snaptrade.com>
   - Verify your email.
   - Generate an **API Key** (`clientId` + `consumerKey`). Store the consumer key as a secret.
   - In the dashboard:
     - **Redirect URIs** → add `https://<your-domain>/snaptrade/callback`.
     - **Webhooks** → add `https://<your-domain>/snaptrade/webhook`, subscribe to at least these events:
       - `USER_DELETED`
       - `CONNECTION_ADDED`, `CONNECTION_DELETED`, `CONNECTION_BROKEN`, `CONNECTION_FIXED`, `CONNECTION_UPDATED`
       - `NEW_ACCOUNT_AVAILABLE`
       - `ACCOUNT_HOLDINGS_UPDATED`, `ACCOUNT_TRANSACTIONS_INITIAL_UPDATE`, `ACCOUNT_TRANSACTIONS_UPDATED`
       - `TRADE_DETECTION` and `TRADE_UPDATE` if your plan supports them (real-time, may cost extra; ask SnapTrade support).
     - Confirm Robinhood (and any other brokers you support) are enabled for your account.
3. **Hosting** — pick one:
   - Railway (easiest, Dockerfile-driven, recommended).
   - Fly.io.
   - Render.
   - Your own VPS with Docker.
4. **DNS**: pick a domain you control (e.g., `bot.example.com`). You need HTTPS — Telegram and SnapTrade webhooks both require a valid TLS cert.
5. **Local tooling** (only required if you want to build/test locally):
   - Node.js 20+, pnpm via Corepack (`corepack enable`), Docker Desktop for local Postgres/Redis.

---

## 2. Generate secrets

Run these once and stash the outputs in your hosting platform's secret manager (Railway Variables, Fly secrets, etc.). Never commit them.

```bash
# 32-byte AES key for SnapTrade userSecret encryption at rest
node scripts/generate-key.js
# example output: f8jR...base64...==

# Telegram webhook secret token (16–256 chars, [A-Za-z0-9_-])
openssl rand -base64 32 | tr '/+' '_-' | tr -d '='

# Internal job secret used to authorize POST /jobs/*
openssl rand -base64 48 | tr '/+' '_-' | tr -d '='
```

> On Windows PowerShell, equivalents:
> ```pwsh
> node scripts/generate-key.js
> [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 })) -replace '[/+=]','_'
> ```

---

## 3. Environment variables (complete reference)

All variables are validated by Zod at boot (`apps/api/src/config/env.ts`). The service refuses to start if any required value is missing or malformed.

| Variable | Required | Example | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | yes | `production` | Setting to `production` also disables mock SnapTrade. |
| `PORT` | no | `3000` | Defaults to 3000. Railway/Fly inject their own — leave unset. |
| `APP_BASE_URL` | yes | `https://bot.example.com` | Public HTTPS URL of this service. Used in `setWebhook` and SnapTrade redirect. |
| `DATABASE_URL` | yes | `postgresql://user:pw@host:5432/db?schema=public` | Use a TLS connection in production (`sslmode=require`). |
| `REDIS_URL` | yes | `rediss://default:pw@host:6379` | Prefer `rediss://`. Username/password parsed from URL. |
| `TELEGRAM_BOT_TOKEN` | yes | `123:AA…` | From BotFather. |
| `TELEGRAM_BOT_USERNAME` | yes in production | `tradeping_bot` | Username without `@`. Startup calls Telegram `getMe` and refuses webhook registration if the identity does not match. |
| `TELEGRAM_WEBHOOK_SECRET` | yes | random 16–256 chars `[A-Za-z0-9_-]` | Sent by Telegram in `X-Telegram-Bot-Api-Secret-Token`; bot rejects mismatches. |
| `INTERNAL_JOB_SECRET` | yes | ≥32 random chars | Bearer token for `POST /jobs/*` and `DELETE /account/delete`. |
| `SNAPTRADE_CLIENT_ID` | yes | `PARTNERTEST` | From SnapTrade dashboard. |
| `SNAPTRADE_CONSUMER_KEY` | yes | long random string | Secret. Used by the SDK to sign every request and to verify webhook HMACs. |
| `SNAPTRADE_REDIRECT_URI` | yes | `https://bot.example.com/snaptrade/callback` | Must exactly match what's whitelisted in the SnapTrade dashboard. |
| `SNAPTRADE_BROKER_SLUG` | no | `ROBINHOOD` | If set, Connection Portal opens directly into that brokerage. Leave blank to show the list. |
| `SNAPTRADE_USE_MOCK` | no | `false` | Must be `false` in production (validated). |
| `ENCRYPTION_KEY_BASE64` | yes | base64 32 bytes | Generated above. Encrypts SnapTrade `userSecret` in Postgres. |
| `RELEASE_SHA` | no | full 40-character Git SHA | Deploy metadata returned by `/healthz` and `/livez`. Recovery always sets and verifies the exact full `origin/main` SHA. |
| `RAILWAY_DEPLOYMENT_ID` | no | `019c92ba-3e22-7c2a-a57c-89f03b330a51` | Railway deployment identity returned by `/healthz` and `/livez`; recovery verifies it against the one deployment created by the upload. |
| `RECOVERY_SUPPRESS_BEFORE` | no at normal boot; required by recovery | `2026-08-11T14:30:00.000Z` | Emergency recovery guard. Recovery requires one explicit canonical UTC timestamp with milliseconds; reuse the exact value on every retry. Earlier executions are recorded but never posted. |
| `TRADE_ORDER_LOOKBACK_DAYS` | no | `3` | How many days of orders to scan per sync (max 90). 3 is sane for near-real-time use. |
| `SYNC_INTERVAL_MINUTES` | no | `5` | Cadence for the external cron hitting `POST /jobs/sync-all`. Lower = more SnapTrade calls. |
| `BACKFILL_SUPPRESS_HOURS` | no | `24` | On a user's first sync, trades older than this are recorded as `BACKFILL` and **not** alerted. |

### Recommended starter values for a private beta

```env
NODE_ENV=production
TRADE_ORDER_LOOKBACK_DAYS=3
SYNC_INTERVAL_MINUTES=5
BACKFILL_SUPPRESS_HOURS=24
SNAPTRADE_USE_MOCK=false
```

---

## 4. Quick path: Railway (recommended)

```bash
# from repo root, after committing all code
railway init                 # or: connect repo in dashboard
railway add --database postgres
railway add --database redis
railway add --service api --repo <github-org-or-user>/<repo> --branch main
```

Then in Railway dashboard:

1. **Service → Variables** → paste every variable from §3.
2. **Service → Settings → Build** → leave the Dockerfile detection on (or set `Dockerfile`).
3. **Service → Settings → Networking** → enable public networking, set the custom domain to `bot.example.com`, and let Railway provision the cert.
4. **Service → Settings → Deploy** → leave the exact start command from
   `railway.json` (`node dist/main.js`) and healthcheck `/healthz`.
5. Keep the API stopped, obtain the public Postgres URL from your secret
   manager, and apply migrations from the exact checked-out release:
   `DATABASE_URL='<public-postgres-url>' corepack pnpm db:deploy`.
6. Trigger the API deploy only after migration succeeds. Watch logs for
   `Nest application successfully started` and verify `/healthz`.

Skip ahead to §8 (Telegram webhook) and §9 (SnapTrade dashboard) once the URL is live.

---

## 5. Alternative: Fly.io

```bash
fly launch --no-deploy --dockerfile Dockerfile
fly postgres create
fly redis create
# Import on stdin so secret values never appear in argv/process listings.
fly secrets import < .env.production
# Keep the API at zero instances during schema changes. From a trusted machine
# connected through Fly's Postgres tunnel/proxy:
DATABASE_URL='<fly-postgres-url>' corepack pnpm db:deploy
fly deploy
```

Point your DNS A/AAAA record at the Fly IP and set the custom domain inside Fly.

---

## 6. Alternative: Self-hosted Docker

On any host with Docker and a reverse proxy that terminates TLS (Caddy, Nginx, Traefik):

```bash
docker build -t tradeping:latest .
docker build --target migration -t tradeping:migration .
# Stop the old API before the migration; do not overlap this privacy release.
docker stop tradeping 2>/dev/null || true
docker run --rm --env-file ./prod.env tradeping:migration
# The API container is stateless; remove the stopped instance before reusing
# its name. Postgres/Redis data must live outside this container.
docker rm tradeping 2>/dev/null || true
docker run -d --name tradeping \
  --env-file ./prod.env \
  -p 127.0.0.1:3000:3000 \
  --restart=unless-stopped \
  tradeping:latest
```

Reverse-proxy config requirements:

- Forward `Host`, `X-Forwarded-For`, `X-Forwarded-Proto`.
- Allow `POST` bodies up to ~1 MB.
- Send TLS termination headers correctly.
- Ensure no body rewriting (the SnapTrade webhook signature is computed over the **exact raw bytes**).

Pair with managed Postgres + Redis (do not run them as containers on the same host for production — too easy to lose data on a reboot).

---

## 7. Database migration

The repo ships with the initial schema plus forward migrations. The explicit
group-consent migration resets legacy memberships to `OFF`, adds the prospective
`sharingEnabledAt` boundary and durable user sync gate, and skips unsafe unsent
events while preserving sent history. To apply against your production DB:

```bash
pnpm db:deploy           # runs prisma migrate deploy
```

With Docker, build and run the dedicated one-off migration target while the API
is stopped, then start the slim runtime image:

```bash
docker build --target migration -t tradeping:migration .
docker run --rm --env-file ./prod.env tradeping:migration
```

When you add new migrations later:

```bash
pnpm --filter @tradeping/api prisma:migrate    # dev
pnpm db:deploy                                  # prod
```

---

## 8. Telegram webhook setup

**This is automatic.** On startup the service first calls Telegram `getMe` and
checks the result against `TELEGRAM_BOT_USERNAME`, then registers the webhook
and slash-command menu (see `TelegramService.onModuleInit`). Registration runs
when `APP_BASE_URL` is a public `https://` URL and `TELEGRAM_BOT_TOKEN` is real.
If those are still placeholders it logs a warning and skips registration.
Identity or registration failures are logged but never crash the service.

Verify after deploy:

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

Require the exact expected URL, `max_connections: 1`, and both `message` and
`my_chat_member` in `allowed_updates`. Investigate an error timestamped at or
after the current deployment; Telegram may retain an older historical
`last_error_message`. A nonzero `pending_update_count` should drain through
normal processing—never clear it by dropping pending updates.

If you change the domain or webhook secret, just restart the service — it
re-registers on boot. To register manually (e.g. without redeploying):

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "content-type: application/json" \
  -d "{
        \"url\":\"https://bot.example.com/telegram/webhook\",
        \"secret_token\":\"$TELEGRAM_WEBHOOK_SECRET\",
        \"allowed_updates\":[\"message\",\"my_chat_member\"],
        \"max_connections\":1
      }"
```

Do not add `drop_pending_updates` during a routine deploy or recovery. Queued
updates can include safety-sensitive `/privacy off` or `/disconnect` requests
and must survive service restarts.

---

## 9. SnapTrade dashboard configuration checklist

In <https://dashboard.snaptrade.com>:

- [ ] **Allowed redirect URIs** includes `https://bot.example.com/snaptrade/callback` exactly.
- [ ] **Webhook URL** = `https://bot.example.com/snaptrade/webhook`.
- [ ] Subscribed to the events listed in §1.
- [ ] **Allowed brokerages** includes Robinhood (and any others you want).
- [ ] Connection type **read** is enabled.
- [ ] If you want sub-second alerts: ask SnapTrade support to enable `TRADE_DETECTION` for your `clientId` and the brokerages you care about.

---

## 10. Adding the bot to your Telegram group

1. Open the group → group settings → **Add Member** → search the bot username.
2. After adding, **promote it to admin** (just the "Delete messages" + "Pin messages" permissions are enough). Admin status guarantees it can see group commands even if privacy mode is on, and avoids any future Telegram behavior changes around bot visibility.
3. In the group, send `/help@yourbot` to confirm it responds.

Per-user onboarding flow:

1. User DMs the bot `/start` (this is required so the bot can later send the brokerage connection link in DM).
2. In the group: `/connect`. The bot DMs the user a SnapTrade Connection Portal link (5-minute TTL).
3. User completes brokerage auth in the portal (read-only).
4. SnapTrade fires `CONNECTION_ADDED` and `ACCOUNT_TRANSACTIONS_INITIAL_UPDATE` → TradePing builds the read-only sync baseline, but group sharing remains `OFF`.
5. In that group, the user explicitly runs `/privacy public`, `/privacy normal`, or `/privacy private`. This records a prospective consent boundary; executions before that instant never post there.

Consent is per user and per group. A connection, reconnect, help/status command,
or interaction in another group never enables sharing. `/privacy off` disables
only the current group and cancels pending delivery there. If a member leaves a
group, that member's sharing is disabled; if the bot is removed, all sharing and
pending delivery for that group are disabled.

---

## 11. Smoke tests after first deploy

Run these in order. Don't ship to real users until all pass.

```bash
# 1. Service health
curl https://bot.example.com/healthz
# expect: {"ok":true,"service":"tradeping-api",...}

# 2. Telegram webhook uses the exact URL, max_connections=1, and
#    allowed_updates=[message,my_chat_member]. No current-deploy error.
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"

# 3. /start in DM with the bot. Expect the help text.
# 4. /connect in group. Expect a DM with a SnapTrade portal URL.
# 5. Complete the portal flow with a real (or test) brokerage account.
# 6. Confirm this group's membership is still OFF with no sharingEnabledAt.
# 7. Within ~1 minute you should see a USER_REGISTERED / CONNECTION_ADDED
#    audit entry:
psql "$DATABASE_URL" -c "SELECT action, metadata, \"createdAt\" FROM \"AuditLog\" ORDER BY \"createdAt\" DESC LIMIT 20;"

# 8. Sync an existing/pre-consent order. Confirm it does not post.
# 9. Run /privacy normal in the group, then place a later executed trade.
#    Confirm only the post-consent trade alerts.
# 10. Run /status and /diagnostics in the group. Confirm details arrive by DM.
# 11. Confirm /groupstatus rejects non-admins and gives admins aggregates only.
# 12. In a second group, confirm sharing remains OFF until a separate /privacy choice.
# 13. /privacy private, then place another trade. Confirm the alert is anonymous
#     and hides quantity/price/value while retaining the broker label.
# 14. /privacy off. Confirm only this group stops and pending alerts here skip.
# 15. In DM, /disconnect must ask for confirmation. /disconnect confirm must
#     disable the durable sync gate and all group sharing before remote revocation.
# 16. Force a manual full sync (proves internal job secret works):
curl -sS -X POST https://bot.example.com/jobs/sync-all \
  -H "authorization: Bearer $INTERNAL_JOB_SECRET"
```

Also test Telegram leave updates: a member leave service message must disable
only that member's sharing in the group. A canonical `my_chat_member` update
with the bot status `left` or `kicked` must disable every membership and pending
alert in that group.

---

## 12. External cron for scheduled syncs

SnapTrade webhooks are the primary trigger. As a safety net, also schedule:

```bash
*/5 * * * * curl -sS -X POST https://bot.example.com/jobs/sync-all \
  -H "authorization: Bearer $INTERNAL_JOB_SECRET" >/dev/null 2>&1
```

Pick one of:

- Railway "Cron" or Fly Scheduled Machines.
- GitHub Actions scheduled workflow.
- Cronitor / EasyCron / cron-job.org.
- A linux box with `cron`.

If your SnapTrade plan reliably fires `ACCOUNT_HOLDINGS_UPDATED` on every change, you can skip this safety net or run it every 15–30 minutes instead of every 5.

---

## 13. Operational runbook

### Railway resource-limit recovery

If Railway reports `You have used all your available resources`, do not start by
deleting Postgres. Postgres is the source of truth for users, connected broker
accounts, Telegram group mappings, privacy settings, trade events, alerts, and
audit logs. Redis and the API service are rebuildable; Postgres is not
rebuildable without forcing every user through setup again.

Safe recovery order:

1. Confirm current state:

   ```bash
   railway status
   railway service list --json
   railway volume list --json
   curl -fsS https://<your-domain>/healthz
   ```

2. If the quota is still blocked, wait for the free-plan quota reset or raise
   the workspace usage limit in Railway Billing/Usage.
3. Choose a single outage boundary, convert it to canonical UTC with
   milliseconds, and record it in the incident log. Do not regenerate or move
   this cutoff on retries. For example, midnight on July 31, 2026 in New York is
   `2026-07-31T04:00:00.000Z`. Also choose one stable recovery run ID. Reuse the
   same run ID, cutoff, and release commit for every retry.
4. From a clean `main` whose HEAD exactly matches `origin/main`, run the CLI
   recovery script. Supply an explicit production env file if the API service
   no longer exists; otherwise the script can validate its preserved remote
   variables.

   ```bash
   cp .env.example .env.production.local
   # Fill .env.production.local from your private secret manager.
   RECOVERY_RUN_ID=tradeping-20260731-outage \
   RECOVERY_SUPPRESS_BEFORE=2026-07-31T04:00:00.000Z \
   TRADEPING_RECOVERY_CONFIRM=restore-tradeping-20260731-outage-before-2026-07-31T04:00:00.000Z \
     corepack pnpm railway:recover .env.production.local
   ```

   To exercise every read-only check and stop before the first production
   mutation, run the same stable contract with
   `TRADEPING_RECOVERY_PREFLIGHT_ONLY=true`. Preflight-only mode does not relax
   the run ID, cutoff, confirmation, Git, Railway identity, volume, tool, or
   environment checks.

The recovery script:

- Pins and verifies the exact GitHub origin, clean `main`, full
  `origin/main` commit, Railway project, production environment, service IDs,
  API domain ID/port, Postgres volume ID/mount/status, and non-zero volume size.
- Requires the explicit stable `RECOVERY_RUN_ID`, canonical
  `RECOVERY_SUPPRESS_BEFORE`, and matching confirmation value. Before any
  production mutation it builds the release, runs the application's real
  environment schema without printing values, confirms that the API is
  offline/source-less, and checks the local PG18 tools, public database URL,
  and backup free space.
- Never creates a replacement Postgres service or empty volume. Because the
  historical Railway deployment is removed, it pins the existing service to
  the checked-in historical Postgres 18 image digest and deploys from that
  immutable source. It polls the exact new deployment ID, verifies its digest
  and volume mount, waits for `SELECT 1` and the TradePing schema, then verifies
  the original `READY` volume again.
- Creates the pre-migration custom-format backup only after PG18 is ready. The
  backup is mode `600` in a mode `700` directory; `pg_restore --list` validates
  its table of contents, a second `pg_restore` renders and decompresses the
  entire archive, and a mandatory SHA-256 sidecar is verified before recovery
  continues. Unique temporary/final names prevent overwrite collisions.
- Marks only pre-cutoff `PENDING` or `SENDING` trade events as
  `BACKFILL`/`SKIPPED` and removes expired webhook idempotency keys. Sent trade
  history and rendered alert receipts are preserved. A transaction-scoped
  lock and durable `AuditLog` contract make an identical retry idempotent and
  reject reuse of a run ID with another cutoff or release SHA.
- Pins Redis to its checked-in historical digest. If Redis or API must be
  recreated, the script captures the new ID and stops before cleanup until the
  operator explicitly confirms that replacement ID. A replacement API must
  also attach the canonical hostname and have its new domain ID explicitly
  confirmed. API creation is source-less; validated variables are stored
  before any code upload.
- Reasserts the API is offline and the exact canonical domain is active on the
  exact source-less service immediately before cleanup. It then uploads the
  clean local commit and polls the one deployment ID created by that upload.
- Accepts success only when the canonical domain's `/healthz` reports
  `service=tradeping-api`, the full 40-character release SHA, that exact
  Railway deployment ID, and Postgres/Redis both up. A failed post-deploy
  verification removes that exact newest deployment when it is safe to do so.
- Calls Telegram `getWebhookInfo` without `drop_pending_updates`. The URL must
  equal the pinned API origin plus `/telegram/webhook`; an error at or after
  the verified deployment is fatal, while a timestamped older error is
  reported as historical. Verification also requires `max_connections: 1`
  and both `message` and `my_chat_member` in `allowed_updates`, preserving
  serialized consent/removal ordering.

Allowed cleanup before the quota reset:

```bash
# Lower-risk cleanup: queue/cache only.
railway volume detach --volume <redis-volume-id> --yes
railway volume delete --volume <redis-volume-id> --yes
railway service delete --service Redis --yes

# Stateless service cleanup. Recovery then requires an explicit production env file.
railway service delete --service api --yes
```

Do not run these unless you explicitly accept a clean beta reset:

```bash
railway volume delete --volume <postgres-volume-id> --yes
railway service delete --service Postgres --yes
```

The script has already created and verified the required pre-migration backup.
After it succeeds, run all smoke tests in §11 before inviting users to trade
again. The explicit-consent migration intentionally resets legacy group
memberships to `OFF`, so each member must make a fresh non-off `/privacy` choice
in each group.

If cleanup must be run independently, use the same incident run ID, cutoff,
full release SHA, and exact confirmation value. Back up and verify Postgres
first:

```bash
corepack pnpm db:backup .env.production.local

RELEASE_SHA="$(git rev-parse HEAD)"
TRADEPING_CLEANUP_CONFIRM=skip-and-clean-tradeping-20260731-outage-before-2026-07-31T04:00:00.000Z \
  corepack pnpm db:recovery-cleanup \
  2026-07-31T04:00:00.000Z .env.production.local \
  tradeping-20260731-outage "$RELEASE_SHA"
```

The cleanup intentionally keeps users, encrypted SnapTrade secrets, broker
authorizations, accounts, Telegram groups, privacy settings, and sync
baselines. It changes only pre-cutoff `PENDING`/`SENDING` events. Previously sent trade
history and rendered `Alert` receipts remain intact.

### Rotating secrets

- **Telegram bot token**: BotFather → `/revoke` → generate new → update `TELEGRAM_BOT_TOKEN` → re-run `setWebhook`.
- **Telegram webhook secret**: generate new value → update env → re-run `setWebhook` with the new `secret_token`.
- **SnapTrade consumer key**: rotate via SnapTrade dashboard → update env → redeploy. Any in-flight webhook still signed with the old key will be rejected; monitor provider retries across the 24-hour signed retry horizon.
- **`ENCRYPTION_KEY_BASE64`**: do **not** replace this key in place. It encrypts
  `encryptedUserSecret` and also keys Telegram-deletion suppression hashes and
  account-name hashes. First deploy versioned/dual-key support. Re-encrypt each
  secret with the new key, but keep the old HMAC key accepted for suppression
  lookup until every old-key row has expired (up to 90 days), because the raw
  Telegram ID no longer exists and those hashes cannot be recomputed. Preserve
  or deliberately migrate account-hash continuity as well. Retire the old key
  only after both encrypted rows and all old-key hash retention windows clear.
- **`INTERNAL_JOB_SECRET`**: rotate freely; only your cron uses it.
- **Database password**: rotate in the managed DB UI → update `DATABASE_URL`.

### Deleting a user (GDPR / "delete me")

```bash
curl -sS -X DELETE https://bot.example.com/account/delete \
  -H "authorization: Bearer $INTERNAL_JOB_SECRET" \
  -H "content-type: application/json" \
  -d '{"telegramUserId":"123456789"}'
```

Deletion is fail-closed and ordered:

1. Disable the durable user sync gate, turn sharing `OFF` in every group,
   cancel pending/sending alerts, mark local broker connections disconnected,
   drain the sync/delivery fences, and purge that user's queued sync/alert jobs.
2. Re-read the provider generation behind the fence. If a SnapTrade user exists,
   create a durable `READY` `ProviderDeletion` tombstone first. In the same
   local scrub, remove memberships, broker connections/accounts, sync state,
   trades/alerts, and user-scoped audit logs; clear the Telegram ID, timezone,
   SnapTrade ID, and encrypted secret. Only the opaque local user record and
   provider deletion tombstone remain.
3. Call `deleteSnapTradeUser`. HTTP success changes the tombstone to `PENDING`
   and returns `remoteDeletionAccepted: true`; this is provider acceptance, not
   confirmation. HTTP failure leaves it `READY` and returns
   `retryRequired: true`. The background retry service runs at startup and
   hourly, retrying every `READY` row plus `PENDING` rows older than 24 hours.
4. A valid signed `USER_DELETED` webhook confirms deletion. If that webhook is
   lost, an authoritative provider `404` while retrying deletion of the exact
   generation-scoped identity also proves absence. Either terminal signal
   removes the minimal local user record and provider tombstone. If no provider
   identity existed, the endpoint can delete the local user immediately.

A provider-backed request normally returns `deleted: false`, `pending: true`,
and an opaque `deletionRequestId`. Store that value in the private support
case: the Telegram identifier has already been scrubbed. An operator can retry
a `READY` request explicitly with:

```bash
curl -sS -X DELETE https://bot.example.com/account/delete \
  -H "authorization: Bearer $INTERNAL_JOB_SECRET" \
  -H "content-type: application/json" \
  -d '{"userId":"<deletionRequestId>"}'
```

Never report deletion as confirmed from `remoteDeletionAccepted: true`; wait
for a signed webhook or the exact-identity authoritative `404` path and a later
lookup returning `notFound: true`. A
secret-only partial provider identity cannot be deleted remotely by ID: local
content and the Telegram identifier are still scrubbed, but the response sets
`manualReviewRequired: true` and retains a PII-minimized blocked record for
operator resolution. Do not manually delete pending/blocked records or
tombstones, because that destroys the retry/confirmation handle. An unknown or
already-confirmed identifier is idempotent and returns
`{ "ok": true, "deleted": false, "pending": false, "notFound": true }`.

### Inspecting state

```sql
-- recent webhook traffic
SELECT action, metadata, "createdAt" FROM "AuditLog"
  WHERE action LIKE 'snaptrade_%' ORDER BY "createdAt" DESC LIMIT 50;

-- pending alerts (should drain quickly)
SELECT count(*) FROM "TradeEvent" WHERE "alertStatus" = 'PENDING';

-- per-user connection health
SELECT u."displayName", c."brokerageName", c.status, c."disabledReason", c."updatedAt"
  FROM "BrokerConnection" c JOIN "User" u ON u.id = c."userId"
  ORDER BY c."updatedAt" DESC;
```

### Common alerts and what to do

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Telegram returns 401 on `setWebhook` | bot token revoked / wrong | rotate token, re-register webhook |
| `getWebhookInfo` shows `last_error_message: "Wrong response from the webhook: 401 Unauthorized"` | `TELEGRAM_WEBHOOK_SECRET` mismatch between env and registration | re-run `setWebhook` with current env |
| Group alerts stop for one user only | connection went `DISABLED` / `ERROR` | user runs `/status`, then `/reconnect`. If more than one connection needs repair, use `/reconnect <broker>` |
| `/connect` fails with "SnapTrade did not return redirectURI" | SnapTrade rejected the login call (likely auth-key issue) | verify `SNAPTRADE_CLIENT_ID` / `SNAPTRADE_CONSUMER_KEY` and that the API key isn't disabled in the dashboard |
| Service won't start, logs `ZodError` | missing or malformed env var | check `apps/api/src/config/env.ts` against your env |
| Worker logs `429 Too Many Requests` from Telegram | bursting in one chat | already handled by the per-chat limiter; if it persists, lower `concurrency` in `apps/api/src/workers/trade-sync.processor.ts` |
| SnapTrade webhook rejected as "Stale" | server clock drift > 5 min | sync NTP on the host |

### Scaling out

For 100+ users:

- Move BullMQ worker into its own service (NestJS supports this — split `TradeSyncProcessor` into a separate app entry).
- Increase worker `concurrency` (`apps/api/src/workers/trade-sync.processor.ts`) and SnapTrade rate limit (`limiter.max`) once you've negotiated higher SnapTrade limits.
- Add Postgres connection pooling via PgBouncer if you ever exceed Prisma's default pool.
- Add Sentry / Datadog / OpenTelemetry. The service currently logs to stdout only.

---

## 14. Updating / redeploying

Standard flow:

```bash
git pull
pnpm install --frozen-lockfile
pnpm db:generate                 # types
pnpm lint && pnpm test           # CI also enforces these
# with the old API drained/stopped, apply migrations through the public DB URL
DATABASE_URL='<public-postgres-url>' pnpm db:deploy
# then push/start the new release (railway up / fly deploy / docker run)
```

Routine code-only releases may use a rolling deploy, but this consent and
deletion-lifecycle release must use a drained maintenance cutover. Stop the old
API/worker before applying its migrations, then start only the new release and
verify `/healthz`, the exact deployment ID, and Telegram webhook configuration.
The pre-release binary does not understand the new privacy boundaries and must
not overlap the migration or post-migration traffic. Run the post-cutover audit
checks in the incident runbook before reopening traffic.

---

## 15. Backup & DR

- Postgres: enable daily snapshots in your managed provider, retain 7+ days. Test restore at least once.
- Redis: queue state is recoverable from re-syncing SnapTrade, so snapshots are nice-to-have, not critical.
- Secrets: store a sealed copy (1Password vault, etc.) outside the hosting platform. Losing `ENCRYPTION_KEY_BASE64` means every stored `userSecret` is unrecoverable.

### Manual Postgres backup

Use the checked-in helper whenever you recover production, run a risky migration,
or before a beta cohort starts trading:

```bash
cp .env.example .env.production.local
# Fill DATABASE_PUBLIC_URL or DATABASE_URL from your private secret manager.
corepack pnpm db:backup .env.production.local
```

The script requires PostgreSQL 18 `pg_dump`, `pg_restore`, and `psql`, confirms
that the server is PG18 and has the expected TradePing schema, checks free
space, and writes a mode-`600` custom-format dump under a mode-`700`
`backups/` directory. It validates the table of contents with `pg_restore
--list`, renders and decompresses the full archive to `/dev/null`, then writes
and verifies a mandatory SHA-256 sidecar before publishing success. Unique
names and no-clobber moves prevent an existing archive or checksum from being
overwritten. `backups/` is excluded from both Git and Docker build contexts.
The Railway recovery helper is stricter: it defaults to
`../tradeping-backups` and refuses any backup directory that resolves inside
the `railway up .` upload context.

For Railway, prefer `DATABASE_PUBLIC_URL` from the Postgres service variables
when running the backup locally. The private `postgres.railway.internal` URL only
works from inside Railway's private network.

Restore drill against a throwaway database:

```bash
createdb tradeping_restore_test
pg_restore --clean --if-exists --no-owner --no-acl \
  --dbname postgresql://localhost:5432/tradeping_restore_test \
  backups/tradeping-postgres-<timestamp>.dump
```

Never restore over production until you have confirmed the target URL and taken a
fresh backup of the current production database.

---

## 16. Going public (beyond beta)

See [docs/LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md). The non-engineering must-haves:

- Counsel-reviewed Terms (`docs/TERMS.md`), Privacy (`docs/PRIVACY.md`), Disclaimer (`docs/DISCLAIMER.md`).
- Pre-recorded onboarding video or screenshots so users know what to expect.
- A support channel (email or DM) staffed during US market hours.
- Incident runbook + on-call rotation if you ever go past ~50 users.

---

## 17. Useful one-liners

```bash
# tail logs (Railway / Fly)
railway logs -f
fly logs

# replay all webhook audit entries from the last hour
psql "$DATABASE_URL" -c "SELECT * FROM \"AuditLog\" WHERE \"createdAt\" > now() - interval '1 hour' ORDER BY \"createdAt\" DESC;"

# force a manual full sync immediately (bypasses queue)
curl -sS -X POST https://bot.example.com/jobs/sync-all-now \
  -H "authorization: Bearer $INTERNAL_JOB_SECRET"

# sync a single user
curl -sS -X POST https://bot.example.com/jobs/sync-user \
  -H "authorization: Bearer $INTERNAL_JOB_SECRET" \
  -H "content-type: application/json" \
  -d '{"userId":"clxxxxxx"}'
```
