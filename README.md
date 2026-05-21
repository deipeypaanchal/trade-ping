# TradePing Bot

Telegram group bot that posts near-real-time buy/sell alerts when members connect read-only brokerage accounts through SnapTrade.

## Current status

Launch-candidate backend for credential-backed testing. Build, lint, unit tests, Prisma generation, and the initial migration are in place. It still requires real Telegram + SnapTrade sandbox/live validation before public users connect brokerage accounts.

## Stack

- TypeScript + NestJS
- PostgreSQL + Prisma
- Redis + BullMQ
- Telegram Bot API webhooks
- SnapTrade Connection Portal + order sync
- AES-256-GCM encryption for SnapTrade user secrets

## Local setup

```bash
cp .env.example .env
node scripts/generate-key.js # copy output to ENCRYPTION_KEY_BASE64
docker compose up -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

For no-credential local smoke tests, set `SNAPTRADE_USE_MOCK=true`.

## Production setup

1. Deploy API to Railway/Fly/AWS.
2. Provision Postgres and Redis.
3. Set all env vars from `.env.example`.
4. Run Prisma migrations with `pnpm db:deploy`.
5. Start the service. It auto-registers the Telegram webhook and command menu on
   boot once `APP_BASE_URL` is a public `https://` URL and `TELEGRAM_BOT_TOKEN`
   is real. Confirm with `getWebhookInfo`.
6. Configure SnapTrade webhook listener to `$APP_BASE_URL/snaptrade/webhook`.
   For real-time alerts, ask SnapTrade support to enable `TRADE_DETECTION` for
   your `clientId`.
7. The service auto-syncs every `SYNC_INTERVAL_MINUTES` as a safety net. You can
   also schedule `POST /jobs/sync-all` with `Authorization: Bearer $INTERNAL_JOB_SECRET`.

## Bot commands

- `/connect` — creates a read-only SnapTrade Connection Portal link.
- `/privacy public|normal|private|off` — controls trade-alert detail level.
- `/trust` — explains bot-level, user-level, group-level, and per-group privacy.
- `/setup` — reposts group onboarding instructions.
- `/status` — refreshes and displays brokerage connection status.
- `/sync` — manually syncs the caller.
- `/disconnect` — revokes brokerage connections.
- `/help` — command list.

## Privacy levels

- `PUBLIC`: display name + ticker + side + quantity + average price + value + broker when the broker exposes order fill data.
- `NORMAL`: display name + ticker + side + quantity + value + broker when the broker exposes order fill data.
- `PRIVATE`: anonymous + ticker + side only.
- `OFF`: no group alerts.

When a broker does not expose an order but positions changed, TradePing can infer the side and quantity. Inferred alerts intentionally say the fill price is unavailable instead of showing a misleading dollar value.

## Trust model

- **Bot level:** shared infrastructure and credentials: Telegram bot, SnapTrade API, Railway, Postgres, Redis, workers, and alert logic.
- **User level:** a member’s Telegram identity, encrypted SnapTrade user secret, connected broker/accounts, and detected trades/positions.
- **Group level:** the Telegram group that receives alerts and the connected members in that group.
- **Per-user per-group level:** `/privacy` controls only one member’s alerts in one group. A member can be public in one group, private in another, and off elsewhere.

## Security posture

- Read-only connection portal is forced with `connectionType: read`.
- Brokerage credentials never touch this app; SnapTrade handles brokerage auth.
- SnapTrade user secrets are encrypted at rest with AES-256-GCM.
- Telegram webhooks are validated with `X-Telegram-Bot-Api-Secret-Token`.
- SnapTrade webhooks are validated with HMAC SHA-256 `Signature` over the raw request body and replay window checks.
- `/account/delete` and `/disconnect` support data deletion / revocation flows.
- Trade alerts include “Not financial advice” disclaimer.

## Pre-ship validation

- Real SnapTrade API credentials and sandbox tests.
- Confirm Robinhood order payload shape in your SnapTrade account.
- Legal review of ToS/privacy/disclaimer.
- Final security review before public rollout.

## License

MIT
