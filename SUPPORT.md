# Support

## For Telegram Users

Start in the group:

- `/help` - command list.
- `/status` - your connected brokers and freshness.
- `/diagnostics` - what TradePing sees for your account in this group.
- `/groupstatus` - group setup and alert health.
- `/trust` - what data lives at bot, user, group, and per-group levels.
- `/disconnect` - revoke brokerage connections.

If a trade does not appear, run `/diagnostics` first. Fidelity and IBKR can be delayed up to 24 hours because broker data may not be available to SnapTrade immediately.

## For Operators

Check:

1. `GET /healthz`.
2. Railway service logs.
3. `/groupstatus` in Telegram.
4. Recent `AuditLog` rows for `job_failed` or sync failures.
5. Recent `TradeEvent` rows for pending or failed alerts.
6. SnapTrade request IDs if the broker data is missing upstream.

## Bugs

Open a GitHub issue with:

- What happened.
- What you expected.
- Broker name.
- Whether `/diagnostics` showed delayed data, pending alerts, or no latest trade.
- Timestamp and timezone.

Do not include tokens, secrets, brokerage credentials, or full account numbers.
