# Launch Checklist

## Repo readiness

- [x] Git repository initialized
- [x] Lockfile committed
- [x] Prisma schema validates
- [x] Initial Prisma migration created
- [x] Build passes
- [x] Tests pass
- [x] Lint passes
- [x] CI runs `db:generate` before lint/test/build
- [ ] Explicit-group-consent migration reviewed: legacy memberships reset to `OFF`, pending unsafe events skipped, sent history preserved
- [ ] Docker image build verified on host (run: `docker build -t tradeping .`)

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
- [ ] Confirm an order executed before explicit group consent never alerts after `/privacy` is enabled

## Telegram

- [ ] Set webhook with secret token
- [ ] Confirm `getMe` matches `TELEGRAM_BOT_USERNAME` before registration
- [ ] Confirm webhook uses the exact URL, `max_connections: 1`, and `allowed_updates` containing `message` and `my_chat_member`
- [ ] Confirm webhook registration preserves pending Telegram updates (no `drop_pending_updates`)
- [ ] Add bot to private group
- [ ] Confirm `/connect` leaves sharing `OFF` until `/privacy public|normal|private` is explicitly run in that group
- [ ] Confirm `/status` and `/diagnostics` invoked in a group send details by DM only
- [ ] Confirm `/groupstatus` is admin-only and aggregate, with no member/account roster or unposted-trade details
- [ ] Confirm a separate `/privacy` choice is required in every group
- [ ] Confirm `/privacy off` cancels pending alerts only for the current group
- [ ] Confirm member leave disables that member's sharing and canonical `my_chat_member` `left`/`kicked` disables all sharing in the group
- [ ] Confirm `/disconnect` in a group redirects the user to DM, and `/disconnect confirm` in DM disables sync and sharing globally
- [ ] Run `/sync` and confirm the queue remains responsive
- [ ] Confirm group alerts render correctly

## Security

- [ ] Secrets stored only in hosting secret manager
- [ ] Database encrypted at rest
- [ ] Redis not publicly exposed
- [ ] Logs checked for secrets/PII leaks
- [ ] Sentry/monitoring configured
- [ ] Recovery tested with one explicit canonical UTC cutoff reused across retries
- [ ] `TRADEPING_RECOVERY_PREFLIGHT_ONLY=true` completes the full pinned preflight and exits before production mutation
- [ ] Recovery refuses a missing/non-ready Postgres volume, starts the pinned existing service from the checked-in PG18 digest, verifies the exact new deployment, and rechecks the original non-empty `READY` volume
- [ ] Restricted, checksum-protected, full-read-validated pre-migration Postgres backup created before cleanup/API deploy
- [ ] Recovery cleanup changes only pre-cutoff `PENDING`/`SENDING` events and preserves sent alert history/receipts
- [ ] Full release SHA, exact Railway deployment ID, database/Redis health, canonical Telegram webhook URL/current error state, serialized connection count, and required update types verified after recovery
- [ ] Incident runbook reviewed (`docs/INCIDENT_RUNBOOK.md`)
- [ ] Durable `brokerSyncEnabled` gate tested for scheduled syncs, webhooks, disconnect, and deletion
- [ ] Account deletion tested: sync/sharing and jobs stop first; local content and Telegram ID are scrubbed before the provider request; the opaque `deletionRequestId`, minimal user, and `READY`/`PENDING` tombstone remain until signed confirmation or exact-identity authoritative provider absence
- [ ] Provider deletion failure remains `READY`, accepted-but-unconfirmed deletion remains `PENDING`, stale `PENDING` retries, and only signed `USER_DELETED` or an authoritative `404` while deleting the exact generation-scoped identity removes the minimal record/tombstone
- [ ] Secret-only partial provider identity returns `manualReviewRequired` without restoring identifiers or sharing
- [ ] SnapTrade webhook signature test passes

## Legal / Product

- [x] Terms of service draft (`docs/TERMS.md` — requires counsel review)
- [x] Privacy policy draft (`docs/PRIVACY.md` — requires counsel review)
- [x] Not-financial-advice disclaimer (`docs/DISCLAIMER.md`, embedded in every alert)
- [ ] Telegram message catalog reviewed against current bot copy (`docs/MESSAGE_CATALOG.md`)
- [x] No copy-trading UI
- [x] No public leaderboard in v1
