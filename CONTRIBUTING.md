# Contributing

Thanks for helping make TradePing calmer, safer, and more useful.

## Local Setup

```bash
cp .env.example .env
node scripts/generate-key.js
docker compose up -d
corepack pnpm install
corepack pnpm db:generate
corepack pnpm db:migrate
corepack pnpm test
```

Use `SNAPTRADE_USE_MOCK=true` for local development without live brokerage credentials.

## Development Rules

- Keep brokerage access read-only.
- Do not add copy-trading, recommendation, leaderboard, or performance-ranking features without a legal/product review.
- Do not log secrets, SnapTrade user secrets, Telegram tokens, brokerage credentials, or raw webhook bodies.
- Prefer small, test-backed changes.
- Keep Telegram copy clear about broker freshness and not-financial-advice.

## Verification

Before opening a pull request:

```bash
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm audit --prod --audit-level=high
```

## Pull Request Notes

Include:

- What changed.
- How it was tested.
- Any migration or deployment notes.
- Any user-facing copy changes.
