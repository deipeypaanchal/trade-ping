# TradePing Message Catalog

This file is the product copy baseline for the Telegram bot. Keep it in sync
with `apps/api/src/telegram/telegram.controller.ts` and
`apps/api/src/alerts/alert.service.ts`.

## Alert Principles

- Lead with the trade in one bold headline.
- Say whether the alert is broker-confirmed, delayed, or provisional.
- Show quantity, price, and total only when the user's privacy setting allows it.
- Keep sharing off until the member explicitly chooses a non-off `/privacy`
  level in that group; never post trades executed before that choice.
- Never present holdings-only changes as confirmed executions.
- Keep every alert read-only and not-financial-advice.
- Prefer clear broker freshness language over "real-time" promises.

## Broker-Confirmed Buy

```text
🟢 Deipey Paanchal bought AAPL
Robinhood · Broker-confirmed

2 shares @ $304.6400
Total debit · $609.28

Executed · Jun 10, 2026, 2:35 AM EDT

✓ Broker-confirmed alert · Read-only · Not financial advice
```

## Broker-Confirmed Option

```text
🟢 Deipey Paanchal bought AAPL $300.00 Call
Robinhood · Broker-confirmed

Expires · Jun 26, 2026
2 contracts @ $4.12 premium
Total debit · $824.00

Executed · Jun 10, 2026, 2:35 AM EDT

✓ Broker-confirmed alert · Read-only · Not financial advice
```

## Broker-Confirmed Sell With Public Return

```text
🔴 Deipey Paanchal sold AAPL
Robinhood · Broker-confirmed

2 shares @ $310.0000
Total credit · $620.00
Est. return · +$10.72 (+1.76%)

Executed · Jun 10, 2026, 2:55 AM EDT

✓ Broker-confirmed alert · Read-only · Not financial advice
```

## Delayed Broker Alert

```text
🟢 Deipey Paanchal bought AAPL
Fidelity · Broker-confirmed

1 share @ $304.6400
Total debit · $304.64

Executed · Jun 9, 2026, 10:15 AM EDT
Received · Jun 10, 2026, 2:35 AM EDT

◷ Delayed broker-confirmed alert · Read-only · Not financial advice
```

## Provisional Robinhood Holdings Change

Only appears when a group admin enables `/inferred on`.

```text
🟡 Deipey Paanchal increased AAPL
Robinhood · Provisional position increase

Observed change · +2 shares
Execution price · Unavailable

Detected · Jun 10, 2026, 2:35 AM EDT

◷ Provisional holdings change · Waiting for broker execution details
```

If SnapTrade later reports the matching execution, TradePing edits the same
Telegram message into the broker-confirmed receipt when possible.

## Private Privacy Alert

```text
🟢 Anonymous member bought AAPL
Robinhood · Broker-confirmed

Executed · Jun 10, 2026, 2:35 AM EDT

✓ Broker-confirmed alert · Read-only · Not financial advice
```

## Group Setup

```text
TradePing is ready for High Risk High Rewards.

To share your trades here:
1. Tap Start private setup so I can DM you safely.
2. Come back and run /connect.
3. Set your group visibility with /privacy.

Each member connects their own read-only brokerage. This group receives alerts only after that member explicitly enables sharing here.
Trades executed before sharing is enabled are never posted into this group.
Alerts depend on broker freshness. Fidelity/IBKR may be delayed up to 24h.
Position-only changes stay in diagnostics unless a group admin enables clearly labeled provisional Robinhood alerts with /inferred on.

Run /trust to see what is bot-level, user-level, and group-level.
```

## Connect Link DM

```text
Connect your brokerage with SnapTrade read-only access:
https://app.snaptrade.com/...

TradePing can read executed trades and positions for alerts. It cannot place trades, move money, or see your brokerage password.
Broker freshness depends on the broker. Fidelity/IBKR may be delayed up to 24h.

The link expires in about 5 minutes. Sharing stays OFF until you return to this group and choose /privacy public, normal, or private.
Run /disconnect confirm in DM anytime to revoke every brokerage connection.
```

## Sharing and Disconnect

After an explicit non-off choice:

```text
Sharing is now NORMAL in this group. Only trades executed after sharing was enabled are eligible.
```

After `/privacy off`:

```text
Sharing is OFF in this group. Pending alerts here were cancelled.
```

`/disconnect` in a group never performs a global action:

```text
To stop sharing only in this group, use /privacy off. To revoke every brokerage connection across TradePing, DM me /disconnect confirm.
```

An unconfirmed DM request explains the scope:

```text
This revokes every brokerage connection and turns sharing off in every TradePing group. Run /disconnect confirm here in DM to continue.
```

The confirmed flow disables the durable sync gate, all group sharing, pending
delivery, and local connections before it attempts remote revocation. If remote
revocation cannot be confirmed, the final DM tells the user to contact support;
local syncing and sharing remain off.

## Group Status

Only a Telegram group admin may run `/groupstatus`. The response is aggregate
health and must not include a member roster, names, brokers, account types, or
unposted trade details.

```text
TradePing group status
Members sharing: 3
Connected sharing members: 3
Provisional Robinhood holdings alerts: off
Pending alerts: 0
Inferred trades skipped in last 24h: 0
Worker failures in last 24h: 0
Freshness: best-effort near-real-time when brokers report fresh data.
Latest posted alert: 1m ago.
Individual names, brokers, account types, and unposted trades are intentionally hidden. Members can use /status for a private DM.
```

For non-admins:

```text
Only a Telegram group admin can view group-wide TradePing health. Use /status for your private connection details.
```

## Status

When `/status` is invoked in a group, TradePing sends the connection and group
sharing details to that member's DM. The group receives only:

```text
Sent your private status in DM.
```

The private response states whether sharing is off or identifies the selected
level, and makes clear that only executions after consent are eligible.

## Diagnostics

When `/diagnostics` is invoked in a group, TradePing sends all user-specific
connection, broker, account-type, sync, and trade details to that member's DM.
The group receives only `Sent your private diagnostics in DM.`

```text
TradePing diagnostics
This group: sharing normal for executions after consent.
Connections: 1.
Broker freshness: best-effort near-real-time where supported.
Robinhood: active; Individual; checked 1m ago; execution feed fresh.
Latest detected here: BUY AAPL via Robinhood at Jun 10, 2026, 6:35:00 AM; new, sent.
Alert result: posted to the group.
If a broker is delayed, /sync cannot force data SnapTrade has not received yet.
```

## Copy Rules

- Use "broker-confirmed" only for order/execution records.
- Use "provisional" only for holdings changes.
- Use "delayed" when receipt trails execution by the configured threshold.
- Do not use "real-time" without a broker freshness caveat.
- Do not mention account numbers or account names in group messages.
- Do not expose member names, broker names, account types, or unposted trades in
  `/groupstatus`; keep it admin-only and aggregate.
- Send group-invoked `/status` and `/diagnostics` details by DM.
- Do not tell users a trade is missing because they did something wrong unless
  `/diagnostics` proves sharing is off or the connection is disabled.
