# Launch Checklist

## Repo readiness

- [x] Git repository initialized
- [x] Lockfile committed
- [x] Prisma schema validates
- [x] Initial Prisma migration created
- [x] Build passes
- [x] Tests pass
- [x] Lint passes
- [ ] Docker image build verified

## Credentials

- [ ] Telegram bot token
- [ ] Telegram webhook secret token
- [ ] SnapTrade client ID
- [ ] SnapTrade consumer key
- [ ] Production Postgres URL
- [ ] Production Redis URL
- [ ] 32-byte base64 encryption key
- [ ] Internal job secret
- [ ] Production domain with HTTPS

## SnapTrade

- [ ] Configure redirect URI
- [ ] Configure webhook URL
- [ ] Confirm read-only connection type is enabled
- [ ] Confirm Robinhood is available for your SnapTrade client
- [ ] Connect a test Robinhood account
- [ ] Place/locate one executed test order
- [ ] Confirm `getUserAccountOrders` payload maps to detector
- [ ] Confirm no historical backfill alerts spam the group

## Telegram

- [ ] Set webhook with secret token
- [ ] Add bot to private group
- [ ] Run `/connect`, `/status`, `/privacy`, `/sync`, `/disconnect`
- [ ] Confirm group alerts render correctly

## Security

- [ ] Secrets stored only in hosting secret manager
- [ ] Database encrypted at rest
- [ ] Redis not publicly exposed
- [ ] Logs checked for secrets/PII leaks
- [ ] Sentry/monitoring configured
- [ ] Account deletion tested
- [ ] SnapTrade webhook signature test passes

## Legal / Product

- [ ] Terms of service
- [ ] Privacy policy
- [ ] Not-financial-advice disclaimer
- [ ] No copy-trading UI
- [ ] No public leaderboard in v1
