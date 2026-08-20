# TradePing Beta Launch Guide

Use this when inviting real users into a Telegram group.

## Positioning

TradePing is a read-only social alert bot. It shows what connected members already did in their brokerage accounts. It is not a copy-trading tool, broker, adviser, leaderboard, or signal service.

Suggested invite copy:

```text
TradePing is live in this group.

Connect a read-only brokerage with /connect if you want your trades to alert here.
Sharing starts OFF. Explicitly enable future alerts in this group with /privacy
public, /privacy normal, or /privacy private. Use /privacy off to keep or turn sharing off.
Trades executed before you enable sharing are never posted here.

Broker freshness varies. Some brokers are close to real time; Fidelity/IBKR can be delayed up to 24h.
TradePing posts broker-reported execution/order records by default. A group admin may opt into clearly labeled provisional Robinhood holdings alerts with `/inferred on` when execution details are unavailable. Delayed brokers such as Fidelity and IBKR remain diagnostic-only because cached holdings can be stale or oscillate between snapshots.
SnapTrade's realtime `recentOrders` capability is optional. TradePing continues using the standard order feed when it is unavailable, with freshness determined by the brokerage and SnapTrade plan.
Use /trust to see what data is bot-level, user-level, and group-level.
Use /privacy off to stop only this group. To revoke all brokerage connections and stop every group, DM the bot /disconnect confirm.
```

## Pin This In Telegram

```text
TradePing group setup:

1. Tap Start private setup once so the bot can DM you.
2. Run /connect in this group.
3. Explicitly choose /privacy public, normal, or private in this group.

Sharing stays OFF until step 3. Only trades executed after that choice are eligible here.

Commands:
/status - DM your connected brokers and this group's sharing state
/reconnect - repair a disabled connection without creating a duplicate
/diagnostics - DM why an alert may not have appeared
/groupstatus - admin-only aggregate group health; no member roster
/trust - read-only trust model
/privacy off - stop sharing only in this group
/disconnect confirm - in DM, revoke every connection and stop all groups

Alerts depend on broker data freshness. Fidelity/IBKR may be delayed up to 24h.
Sell P/L is estimated only when TradePing has both sell price and prior cost basis.
```

## Smoke Test

Run this after each deploy:

1. `GET /healthz` returns `ok: true`.
2. Telegram `getMe` matches the configured username; webhook info shows the
   exact URL, `max_connections: 1`, both `message` and `my_chat_member`, and no
   dropped pending updates. The command menu includes `/diagnostics` and
   `/groupstatus`.
3. Connect a test account and confirm the new group membership remains `OFF` until an explicit non-off `/privacy` choice.
4. Before enabling sharing, run a sync with an existing order and confirm no pre-consent alert is posted.
5. Enable `/privacy normal`, then confirm only a trade executed after that consent boundary can alert in this group.
6. In a second group, confirm commands and connection state alone do not enable sharing; make a separate `/privacy` choice before expecting alerts there.
7. In the group, run `/status` and `/diagnostics`; detailed results must arrive by DM and the group must receive only an acknowledgement.
8. Confirm `/groupstatus` rejects non-admins and gives admins aggregate health without member, broker, account-type, or unposted-trade details.
9. Run `/sync`; it should reply immediately and not block the chat. Confirm worker logs show automatic sync every configured interval.
10. For Fidelity/IBKR, verify the private `/diagnostics` response explains broker freshness instead of promising realtime.
11. For option alerts, verify execution values use contract value.
12. Confirm `/privacy off` stops only the current group and cancels pending alerts there.
13. Confirm a member leave disables that member's sharing, and canonical
    `my_chat_member` `left`/`kicked` updates disable all sharing for that group.
14. In DM, confirm `/disconnect` asks for confirmation and `/disconnect confirm` disables the durable sync gate and every group before remote revocation is attempted.
15. With a disposable test user, exercise account deletion: local content and
    Telegram identity must be scrubbed before the provider call; HTTP acceptance
    must remain pending with an opaque `deletionRequestId`; a provider failure
    must remain retryable; only signed `USER_DELETED` confirmation or an
    authoritative provider `404` while deleting the exact generation-scoped
    identity may remove the minimal user/tombstone.

## Support Playbook

When someone says "my trade did not ping":

1. Ask them to run `/diagnostics` in the group; the details arrive privately by DM.
2. Check whether sharing is off or was never explicitly enabled. `PRIVATE` still alerts anonymously; it is not an off switch.
3. Check broker freshness. Fidelity/IBKR can lag up to 24h.
4. Ask a group admin to check the aggregate `/groupstatus` for pending alerts or worker failures. Do not request a public roster or private diagnostics screenshot.
5. If the private `/status` response reports a disabled connection, run `/reconnect`.
6. If the broker should be fresh, inspect recent `AuditLog` and `TradeEvent` rows.
7. If SnapTrade does not expose the order/position, capture request IDs and ask SnapTrade support.

## Beta Quality Bar

Before inviting more users:

- Production deploy is green.
- `/healthz` monitor is active.
- Telegram bot identity, serialized webhook (`message` + `my_chat_member`), and
  command menu are verified for the exact release, with queued updates
  preserved across deploys.
- Read-only connection, explicit prospective group consent, cross-group isolation, member/bot leave handling, `/privacy off`, and DM-only `/disconnect confirm` are tested.
- Durable sync gating and asynchronous deletion are verified, including
  immediate local scrubbing, provider failure/stale-pending retries, and signed
  confirmation cleanup.
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
