# TradePing Beta Launch Guide

Use this when inviting real users into a Telegram group.

## Positioning

TradePing is a read-only social alert bot. It shows what connected members already did in their brokerage accounts. It is not a copy-trading tool, broker, adviser, leaderboard, or signal service.

Suggested invite copy:

```text
TradePing is live in this group.

Connect a read-only brokerage with /connect if you want your trades to alert here.
You control your visibility with /privacy:
public, normal, private, or off.

Broker freshness varies. Some brokers are close to real time; Fidelity/IBKR can be delayed up to 24h.
TradePing posts only broker-reported execution/order records. Position-only changes are used for diagnostics, not group alerts. This is an invariant, not a configurable group setting: cached holdings can be stale or oscillate between snapshots.
Use /trust to see what data is bot-level, user-level, and group-level.
```

## Pin This In Telegram

```text
TradePing group setup:

1. Tap Start private setup once so the bot can DM you.
2. Run /connect in this group.
3. Choose visibility with /privacy.

Commands:
/status - your connected brokers
/diagnostics - why an alert may not have appeared
/groupstatus - group setup health
/trust - read-only trust model
/disconnect - revoke broker connections

Alerts depend on broker data freshness. Fidelity/IBKR may be delayed up to 24h.
Sell P/L is estimated only when TradePing has both sell price and prior cost basis.
```

## Smoke Test

Run this after each deploy:

1. `GET /healthz` returns `ok: true`.
2. Telegram command menu includes `/diagnostics` and `/groupstatus`.
3. In the group, run `/help`, `/status`, `/diagnostics`, and `/groupstatus`.
4. Run `/sync`; it should reply immediately and not block the chat.
5. Confirm worker logs show automatic sync every configured interval.
6. Place or verify a Robinhood trade if available.
7. For Fidelity/IBKR, verify `/diagnostics` explains broker freshness instead of promising realtime.
8. For option alerts, verify execution values use contract value.

## Support Playbook

When someone says "my trade did not ping":

1. Ask them to run `/diagnostics` in the group.
2. Check if alerts are off or privacy is private.
3. Check broker freshness. Fidelity/IBKR can lag up to 24h.
4. Check `/groupstatus` for pending alerts or worker failures.
5. If the broker should be fresh, inspect recent `AuditLog` and `TradeEvent` rows.
6. If SnapTrade does not expose the order/position, capture request IDs and ask SnapTrade support.

## Beta Quality Bar

Before inviting more users:

- Production deploy is green.
- `/healthz` monitor is active.
- Telegram webhook and command menu registered on latest deploy.
- Read-only connection and `/disconnect` tested.
- Terms, privacy policy, and disclaimer are visible in the repo.
- No secrets are committed.
- The group understands broker freshness and privacy levels.

## Do Not Add Yet

Avoid these until the legal/product surface is clearer:

- Copy-trading prompts.
- Leaderboards.
- Performance rankings.
- Trade recommendations.
- Any command that places, modifies, or cancels trades.
