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
5. Configure Telegram webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "content-type: application/json" \
  -d "{\"url\":\"$APP_BASE_URL/telegram/webhook\",\"secret_token\":\"$TELEGRAM_WEBHOOK_SECRET\",\"allowed_updates\":[\"message\"]}"
```

6. Configure SnapTrade webhook listener to `$APP_BASE_URL/snaptrade/webhook`.
7. Schedule `POST /jobs/sync-all` every 5 minutes with `Authorization: Bearer $INTERNAL_JOB_SECRET` if you are not relying only on SnapTrade webhooks.

## Bot commands

- `/connect` — creates a read-only SnapTrade Connection Portal link.
- `/privacy public|normal|private|off` — controls trade-alert detail level.
- `/status` — refreshes and displays brokerage connection status.
- `/sync` — manually syncs the caller.
- `/disconnect` — revokes brokerage connections.
- `/help` — command list.

## Privacy levels

- `PUBLIC`: display name + ticker + side + quantity + price + broker.
- `NORMAL`: display name + ticker + side + broker.
- `PRIVATE`: anonymous + ticker + side only.
- `OFF`: no group alerts.

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
