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
- Health check: `GET /healthz`.

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
| `TELEGRAM_WEBHOOK_SECRET` | yes | random 16–256 chars `[A-Za-z0-9_-]` | Sent by Telegram in `X-Telegram-Bot-Api-Secret-Token`; bot rejects mismatches. |
| `INTERNAL_JOB_SECRET` | yes | ≥32 random chars | Bearer token for `POST /jobs/*` and `DELETE /account/delete`. |
| `SNAPTRADE_CLIENT_ID` | yes | `PARTNERTEST` | From SnapTrade dashboard. |
| `SNAPTRADE_CONSUMER_KEY` | yes | long random string | Secret. Used by the SDK to sign every request and to verify webhook HMACs. |
| `SNAPTRADE_REDIRECT_URI` | yes | `https://bot.example.com/snaptrade/callback` | Must exactly match what's whitelisted in the SnapTrade dashboard. |
| `SNAPTRADE_BROKER_SLUG` | no | `ROBINHOOD` | If set, Connection Portal opens directly into that brokerage. Leave blank to show the list. |
| `SNAPTRADE_USE_MOCK` | no | `false` | Must be `false` in production (validated). |
| `ENCRYPTION_KEY_BASE64` | yes | base64 32 bytes | Generated above. Encrypts SnapTrade `userSecret` in Postgres. |
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
railway add --plugin postgresql
railway add --plugin redis
```

Then in Railway dashboard:

1. **Service → Variables** → paste every variable from §3.
2. **Service → Settings → Build** → leave the Dockerfile detection on (or set `Dockerfile`).
3. **Service → Settings → Networking** → enable public networking, set the custom domain to `bot.example.com`, and let Railway provision the cert.
4. **Service → Settings → Deploy** → leave the start command from `railway.json` (`node apps/api/dist/main.js`) and healthcheck `/healthz`.
5. Trigger a deploy. Watch logs for `Nest application successfully started`.

Run the initial migration once the service is up:

```bash
railway run pnpm db:deploy
```

Skip ahead to §8 (Telegram webhook) and §9 (SnapTrade dashboard) once the URL is live.

---

## 5. Alternative: Fly.io

```bash
fly launch --no-deploy --dockerfile Dockerfile
fly postgres create
fly redis create
fly secrets set $(cat .env.production | xargs)   # or set them one at a time
fly deploy
fly ssh console -C "node apps/api/node_modules/.bin/prisma migrate deploy --schema /app/prisma/schema.prisma"
```

Point your DNS A/AAAA record at the Fly IP and set the custom domain inside Fly.

---

## 6. Alternative: Self-hosted Docker

On any host with Docker and a reverse proxy that terminates TLS (Caddy, Nginx, Traefik):

```bash
docker build -t tradeping:latest .
docker run -d --name tradeping \
  --env-file ./prod.env \
  -p 127.0.0.1:3000:3000 \
  --restart=unless-stopped \
  tradeping:latest
docker exec tradeping node apps/api/node_modules/.bin/prisma migrate deploy --schema /app/prisma/schema.prisma
```

Reverse-proxy config requirements:

- Forward `Host`, `X-Forwarded-For`, `X-Forwarded-Proto`.
- Allow `POST` bodies up to ~1 MB.
- Send TLS termination headers correctly.
- Ensure no body rewriting (the SnapTrade webhook signature is computed over the **exact raw bytes**).

Pair with managed Postgres + Redis (do not run them as containers on the same host for production — too easy to lose data on a reboot).

---

## 7. Database migration

The repo ships with `prisma/migrations/20260520000000_init/` covering the entire schema. To apply against your production DB:

```bash
pnpm db:deploy           # runs prisma migrate deploy
```

Inside Docker:

```bash
docker exec <container> node apps/api/node_modules/.bin/prisma migrate deploy \
  --schema /app/prisma/schema.prisma
```

When you add new migrations later:

```bash
pnpm --filter @tradeping/api prisma:migrate    # dev
pnpm db:deploy                                  # prod
```

---

## 8. Telegram webhook setup

**This is automatic.** On startup the service registers the webhook **and** the
slash-command menu itself (see `TelegramService.onModuleInit`), as long as
`APP_BASE_URL` is a public `https://` URL and `TELEGRAM_BOT_TOKEN` is real.
If those are still placeholders it logs a warning and skips registration, so
just set them and redeploy. Failures are logged but never crash the service.

Verify after deploy:

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

You should see your URL, `pending_update_count: 0`, and `last_error_message: null`.

If you change the domain or webhook secret, just restart the service — it
re-registers on boot. To register manually (e.g. without redeploying):

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "content-type: application/json" \
  -d "{
        \"url\":\"https://bot.example.com/telegram/webhook\",
        \"secret_token\":\"$TELEGRAM_WEBHOOK_SECRET\",
        \"allowed_updates\":[\"message\"],
        \"drop_pending_updates\":true
      }"
```

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
4. SnapTrade fires `CONNECTION_ADDED` and `ACCOUNT_TRANSACTIONS_INITIAL_UPDATE` → we sync, suppress backfill, and arm future alerts.
5. User can set privacy any time: `/privacy public|normal|private|off`.

---

## 11. Smoke tests after first deploy

Run these in order. Don't ship to real users until all pass.

```bash
# 1. Service health
curl https://bot.example.com/healthz
# expect: {"ok":true,"service":"tradeping-api",...}

# 2. Telegram webhook registered, no errors
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"

# 3. /start in DM with the bot. Expect the help text.
# 4. /connect in group. Expect a DM with a SnapTrade portal URL.
# 5. Complete the portal flow with a real (or test) brokerage account.
# 6. Within ~1 minute you should see a USER_REGISTERED / CONNECTION_ADDED
#    audit entry:
psql "$DATABASE_URL" -c "SELECT action, metadata, \"createdAt\" FROM \"AuditLog\" ORDER BY \"createdAt\" DESC LIMIT 20;"

# 7. Place (or wait for) a real executed buy/sell. Confirm a group alert posts.
# 8. /privacy private then place another trade → confirm the alert hides quantity/price/broker.
# 9. /disconnect → confirm the broker connections are removed and group alerts stop.
# 10. Force a manual full sync (proves internal job secret works):
curl -sS -X POST https://bot.example.com/jobs/sync-all \
  -H "authorization: Bearer $INTERNAL_JOB_SECRET"
```

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

### Rotating secrets

- **Telegram bot token**: BotFather → `/revoke` → generate new → update `TELEGRAM_BOT_TOKEN` → re-run `setWebhook`.
- **Telegram webhook secret**: generate new value → update env → re-run `setWebhook` with the new `secret_token`.
- **SnapTrade consumer key**: rotate via SnapTrade dashboard → update env → redeploy. Any in-flight webhook with the old signature within 5 minutes will be rejected (acceptable).
- **`ENCRYPTION_KEY_BASE64`**: do **not** rotate without a migration plan — every `encryptedUserSecret` row was encrypted with the old key. If you must rotate, write a one-time script that reads with the old key and re-writes with the new key inside a transaction. See [docs/CODE_REVIEW_DETAILED.md](CODE_REVIEW_DETAILED.md#key-rotation).
- **`INTERNAL_JOB_SECRET`**: rotate freely; only your cron uses it.
- **Database password**: rotate in the managed DB UI → update `DATABASE_URL`.

### Deleting a user (GDPR / "delete me")

```bash
curl -sS -X DELETE https://bot.example.com/account/delete \
  -H "authorization: Bearer $INTERNAL_JOB_SECRET" \
  -H "content-type: application/json" \
  -d '{"telegramUserId":"123456789"}'
```

This calls SnapTrade `removeBrokerageAuthorization` on every active connection, then deletes the local `User` row. Cascades remove memberships, broker connections, accounts, trade events, alerts.

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
| Group alerts stop for one user only | connection went `DISABLED` / `ERROR` | user runs `/status`, then `/connect` (which reconnects); or use SnapTrade reconnect flow |
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
pnpm db:deploy                   # if there are new migrations
# push to your hosting provider (railway up / fly deploy / docker pull)
```

Rolling deploy is safe: the service is stateless, the queue persists in Redis, and Prisma migrations are forward-compatible.

---

## 15. Backup & DR

- Postgres: enable daily snapshots in your managed provider, retain 7+ days. Test restore at least once.
- Redis: queue state is recoverable from re-syncing SnapTrade, so snapshots are nice-to-have, not critical.
- Secrets: store a sealed copy (1Password vault, etc.) outside the hosting platform. Losing `ENCRYPTION_KEY_BASE64` means every stored `userSecret` is unrecoverable.

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
