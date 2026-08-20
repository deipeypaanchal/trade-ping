# TradePing

Read-only trade alerts for Telegram groups.

TradePing lets members connect brokerage accounts through SnapTrade, then posts buy/sell alerts into a Telegram group according to each member's privacy setting. Sharing defaults to off and must be enabled explicitly with `/privacy` in each intended group. It is built for small trading communities that want transparency without handing anyone trading authority.

Alerts are best-effort near-real-time where broker data supports it. Fidelity and IBKR data can be delayed up to 24 hours.

## What Users See

- A group setup flow that keeps brokerage links private in DM.
- Read-only alerts with ticker, side, quantity, price/value when available, estimated sell P/L when cost basis is available, broker, and a not-financial-advice reminder.
- Fail-closed per-user, per-group sharing: off until the member explicitly chooses public, normal, or private in that group.
- `/trust` to explain bot-level, user-level, group-level, and per-group data.
- Private `/diagnostics` and `/status` results, plus an admin-only aggregate `/groupstatus` with no member roster.

## Stack

- TypeScript + NestJS
- PostgreSQL + Prisma
- Redis + BullMQ
- Telegram Bot API webhooks
- SnapTrade Connection Portal, recent orders, historical orders, and holdings sync
- AES-256-GCM encryption for SnapTrade user secrets

## Quick Start

```bash
cp .env.example .env
node scripts/generate-key.js # copy output to ENCRYPTION_KEY_BASE64
docker compose up -d
corepack pnpm install
corepack pnpm db:generate
corepack pnpm db:migrate
corepack pnpm dev
```

For no-credential local smoke tests, set:

```env
SNAPTRADE_USE_MOCK=true
```

## Production Checklist

1. Create a Telegram bot with BotFather.
2. Disable Telegram bot privacy mode so group slash commands are visible.
3. Create SnapTrade API credentials.
4. Configure SnapTrade redirect URI: `https://<your-domain>/snaptrade/callback`.
5. Configure SnapTrade webhook URL: `https://<your-domain>/snaptrade/webhook`.
6. Provision Postgres and Redis.
7. Set all environment variables from `.env.example`.
8. Run migrations with `corepack pnpm db:deploy`.
9. Deploy the API.
10. Confirm `GET /healthz` returns `{"ok":true}` with Postgres and Redis checks.

The service verifies the configured bot username with Telegram `getMe`, then
registers the webhook and command menu automatically on boot when
`APP_BASE_URL` is public HTTPS and `TELEGRAM_BOT_TOKEN` is real. Webhook
delivery is serialized with `max_connections: 1`, subscribes to both `message`
and canonical `my_chat_member` updates, and never drops queued updates during
registration or restart.

## Railway Recovery

If Railway pauses the project for a free-plan resource limit, protect Postgres
first. Postgres contains users, connected broker accounts, Telegram group
mappings, privacy settings, trade events, alerts, and audit logs. Redis and the
API service can be rebuilt.

After the Railway quota resets or the workspace usage limit is raised, choose
one canonical UTC cutoff and reuse that exact value on every retry:

```bash
cp .env.example .env.production.local
# Fill .env.production.local from your private secret manager.
RECOVERY_RUN_ID=tradeping-20260811-outage \
RECOVERY_SUPPRESS_BEFORE=2026-08-11T14:30:00.000Z \
TRADEPING_RECOVERY_CONFIRM=restore-tradeping-20260811-outage-before-2026-08-11T14:30:00.000Z \
  corepack pnpm railway:recover .env.production.local
```

The recovery command requires a clean `main` at the exact `origin/main` commit,
the pinned Railway project/environment/service/volume identities, and the
original non-empty Postgres volume. It starts Postgres 18 from the checked-in
historical image digest, waits for that exact deployment and schema, creates a
checksum-protected full-read-validated pre-migration backup, and records the
stable run ID/cutoff/release contract in Postgres. Cleanup neutralizes only
pre-cutoff `PENDING`/`SENDING` work while preserving sent alert history. The
source-less API upload succeeds only after the pinned domain reports the full
release SHA, exact Railway deployment ID, Postgres, and Redis, and Telegram's
webhook is verified without dropping queued updates.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#railway-resource-limit-recovery)
for the full runbook.

## Bot Commands

- `/connect` - connect a read-only brokerage.
- `/reconnect [broker]` - repair an existing disabled brokerage connection without creating a duplicate.
- `/privacy public|normal|private|off` - explicitly enable future sharing, or turn it off, in this group only.
- `/inferred on|off` - group admin toggle for clearly labeled provisional Robinhood holdings alerts when execution details are unavailable.
- `/trust` - explain what data is bot-level, user-level, group-level, and per-group.
- `/diagnostics` - explain your latest sync, broker freshness, latest detected trade, and why it did or did not alert; a group invocation sends the details by DM.
- `/groupstatus` - group-admin-only aggregate health with no member, broker, account, or unposted-trade roster.
- `/setup` - repost group onboarding instructions.
- `/status` - show your connected brokers and, when invoked in a group, send those details privately by DM.
- `/sync` - manual backup check. This cannot force delayed broker data to appear.
- `/disconnect [confirm]` - in DM, show the global scope and require `/disconnect confirm` before revoking all brokerage connections, disabling syncing, and turning sharing off in every group. Use `/privacy off` to stop only one group.
- `/help` - command list.

## Privacy Levels

Every group starts at `OFF`. Connecting a brokerage, using another command, or
joining another group does not grant sharing consent. A non-off `/privacy`
choice records a prospective consent boundary; trades executed before that
instant are never posted to that group. Switching between enabled levels keeps
the boundary; turning sharing off and back on creates a new one.

- `PUBLIC`: name, ticker, side, quantity, execution price, total debit/credit, estimated sell return, and broker when available.
- `NORMAL`: name, ticker, side, quantity, execution price, total debit/credit, and broker when available.
- `PRIVATE`: anonymous member, ticker, side, and broker only.
- `OFF`: no group alerts.

TradePing only posts group alerts from broker execution/order records. Position changes without a matching broker order are kept for diagnostics because they can be stale or ambiguous.

## Broker Freshness

TradePing checks automatically in the background and reacts to SnapTrade webhooks where available. Broker freshness still depends on the brokerage:

- Robinhood and many brokers can appear close to real time when SnapTrade receives fresh data.
- Fidelity and IBKR can be delayed up to 24 hours.
- SnapTrade's realtime `recentOrders` endpoint is an optional capability. TradePing degrades to the standard order feed when it is unavailable.
- Broker-confirmed executions are the default. Group admins may opt into provisional Robinhood holdings alerts with `/inferred on`; they are labeled as position changes and never presented as confirmed fills.
- If SnapTrade later reports the matching broker execution, TradePing upgrades that provisional Telegram message inline to the final broker-confirmed receipt.
- `/diagnostics` is the first support command when a user asks why an alert did not appear. It will distinguish between posted alerts, queued alerts, delayed broker data, historical backfill, and inferred holdings changes that were intentionally skipped.
- `/status` and `/diagnostics` invoked in a group send user-specific details to that member's DM. `/groupstatus` is the admin-only group check and exposes aggregate sharing/connection counts, pending alerts, recent failures, freshness, and the age of the latest posted alert without a roster.

## Trust Model

- **Bot level:** shared infrastructure and credentials: Telegram bot, SnapTrade API, hosting, Postgres, Redis, workers, and alert logic.
- **User level:** Telegram identity, encrypted SnapTrade user secret, connected brokers/accounts, and detected trades/positions.
- **Group level:** the Telegram group destination and aggregate alert health. Member and bot leave events disable affected sharing and cancel pending delivery.
- **Position-only fallback:** holdings changes are recorded for support visibility. They post only as clearly labeled provisional Robinhood alerts when a group admin opts in with `/inferred on`; delayed brokers remain diagnostic-only.
- **Per-user per-group level:** `/privacy` explicitly enables or disables only one member's future alerts in one group. It never releases pre-consent trades.

## Security Posture

- Read-only SnapTrade connection portal is forced with `connectionType: read`.
- Brokerage credentials never touch this app; SnapTrade handles brokerage auth.
- SnapTrade user secrets are encrypted at rest with AES-256-GCM.
- Telegram webhooks are validated with `X-Telegram-Bot-Api-Secret-Token`.
- SnapTrade webhooks are validated with HMAC SHA-256 over the raw request body plus replay checks.
- A durable user-level sync gate is disabled before global disconnect or account deletion, so webhook and scheduled sync paths stay off even when remote revocation is unavailable.
- `/disconnect confirm` in DM disables all group sharing before attempting provider-side authorization revocation. `/privacy off` affects only the current group.
- `DELETE /account/delete` immediately disables sync/sharing, removes queued
  jobs, scrubs user content and the Telegram identifier, and returns an opaque
  `deletionRequestId`. If provider deletion is required, only a minimal local
  record and retry tombstone remain until a signed SnapTrade `USER_DELETED`
  webhook confirms completion or a deletion retry receives an authoritative
  provider `404` for that exact generation-scoped identity. HTTP acceptance
  means pending, not confirmed; `READY` failures and stale `PENDING` requests
  are retried safely.
- Every alert includes a not-financial-advice disclaimer.

## Useful Docs

- [Deployment Guide](docs/DEPLOYMENT.md)
- [Incident Runbook](docs/INCIDENT_RUNBOOK.md)
- [2026-06-02 End-to-End Audit](docs/E2E_AUDIT_2026-06-02.md)
- [Beta Launch Guide](docs/BETA_LAUNCH.md)
- [Launch Readiness](docs/LAUNCH_READINESS.md)
- [Telegram Message Catalog](docs/MESSAGE_CATALOG.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Privacy Policy Draft](docs/PRIVACY.md)
- [Terms Draft](docs/TERMS.md)
- [Disclaimer](docs/DISCLAIMER.md)

## License

MIT
