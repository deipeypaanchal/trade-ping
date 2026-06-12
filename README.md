# TradePing

Read-only trade alerts for Telegram groups.

TradePing lets members connect brokerage accounts through SnapTrade, then posts buy/sell alerts into a Telegram group according to each member's privacy setting. It is built for small trading communities that want transparency without handing anyone trading authority.

Alerts are best-effort near-real-time where broker data supports it. Fidelity and IBKR data can be delayed up to 24 hours.

## What Users See

- A group setup flow that keeps brokerage links private in DM.
- Read-only alerts with ticker, side, quantity, price/value when available, estimated sell P/L when cost basis is available, broker, and a not-financial-advice reminder.
- Per-user, per-group privacy: public, normal, private, or off.
- `/trust` to explain bot-level, user-level, group-level, and per-group data.
- `/diagnostics`, `/status`, and `/groupstatus` for support when a trade does not appear.

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

The service registers the Telegram webhook and command menu automatically on boot when `APP_BASE_URL` is public HTTPS and `TELEGRAM_BOT_TOKEN` is real.

## Railway Recovery

If Railway pauses the project for a free-plan resource limit, protect Postgres
first. Postgres contains users, connected broker accounts, Telegram group
mappings, privacy settings, trade events, alerts, and audit logs. Redis and the
API service can be rebuilt.

After the Railway quota resets or the workspace usage limit is raised:

```bash
cp .env.example .env.production.local
# Fill .env.production.local from your private secret manager.
corepack pnpm railway:recover .env.production.local
```

After Postgres is back online, take a backup before inviting users to trade:

```bash
corepack pnpm db:backup .env.production.local
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#railway-resource-limit-recovery)
for the full runbook.

## Bot Commands

- `/connect` - connect a read-only brokerage.
- `/reconnect [broker]` - repair an existing disabled brokerage connection without creating a duplicate.
- `/privacy public|normal|private|off` - choose how your alerts appear in this group.
- `/inferred on|off` - group admin toggle for clearly labeled provisional Robinhood holdings alerts when execution details are unavailable.
- `/trust` - explain what data is bot-level, user-level, group-level, and per-group.
- `/diagnostics` - explain latest sync, broker freshness, latest detected trade, and why it did or did not alert.
- `/groupstatus` - show group setup and alert health without exposing account names or numbers.
- `/setup` - repost group onboarding instructions.
- `/status` - in private chat, show your connected brokers; in a group, show linked members, brokers, account types, freshness, and alert health.
- `/sync` - manual backup check. This cannot force delayed broker data to appear.
- `/disconnect` - revoke brokerage connections.
- `/help` - command list.

## Privacy Levels

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
- `/status` in the group is the quickest group-level transparency check: it shows which Telegram member linked each broker, account type labels, privacy state, pending alerts, skipped inferred events in the last 24 hours, and worker failures.

## Trust Model

- **Bot level:** shared infrastructure and credentials: Telegram bot, SnapTrade API, hosting, Postgres, Redis, workers, and alert logic.
- **User level:** Telegram identity, encrypted SnapTrade user secret, connected brokers/accounts, and detected trades/positions.
- **Group level:** the Telegram group destination and the connected members in that group.
- **Position-only fallback:** holdings changes are recorded for support visibility. They post only as clearly labeled provisional Robinhood alerts when a group admin opts in with `/inferred on`; delayed brokers remain diagnostic-only.
- **Per-user per-group level:** `/privacy` controls only one member's alerts in one group.

## Security Posture

- Read-only SnapTrade connection portal is forced with `connectionType: read`.
- Brokerage credentials never touch this app; SnapTrade handles brokerage auth.
- SnapTrade user secrets are encrypted at rest with AES-256-GCM.
- Telegram webhooks are validated with `X-Telegram-Bot-Api-Secret-Token`.
- SnapTrade webhooks are validated with HMAC SHA-256 over the raw request body plus replay checks.
- `/disconnect` and `DELETE /account/delete` support revocation and deletion flows.
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
