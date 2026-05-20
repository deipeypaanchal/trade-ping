# Architecture

```text
Telegram group
  ↓ /connect, /privacy, /sync
NestJS API
  ↓
SnapTrade Connection Portal (read-only)
  ↓
Brokerage account / Robinhood, Schwab, Fidelity, etc.
  ↓ webhook or scheduled sync
BrokerSyncService
  ↓
TradeDetectorService
  ↓
AlertService + PrivacyService
  ↓
Telegram group alert
```

## Components

- `TelegramController`: command router and webhook verification.
- `SnaptradeService`: all SnapTrade REST calls, isolated for easy SDK replacement if needed.
- `BrokerOnboardingService`: register SnapTrade user, create read-only portal, refresh/delete connections.
- `BrokerSyncService`: sync connections/accounts/orders, dedupe, suppress backfill, create trade events.
- `TradeDetectorService`: normalize executed buy/sell orders only.
- `AlertService`: render privacy-safe group messages.
- `SnaptradeWebhookController`: verify SnapTrade webhooks and enqueue sync.
- `WorkersModule`: BullMQ queue for sync jobs.

## Polling guidance

Use SnapTrade webhooks when available. If scheduled sync is required, start conservatively and tune only after SnapTrade approval and testing.
