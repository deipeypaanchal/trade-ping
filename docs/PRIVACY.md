# Privacy Policy — TradePing Bot

_Last updated: 2026-08-11. Replace with counsel-reviewed text before public launch._

## What we collect

- Telegram user id and display name/username when you use a TradePing command,
  plus group chat ids needed for TradePing group operations. Ordinary
  non-command chat text is not retained.
- A SnapTrade `userId` and an encrypted `userSecret` issued by SnapTrade after
  you initiate `/connect`. The secret is encrypted at rest with AES-256-GCM.
- Brokerage connection metadata returned by SnapTrade (brokerage name, slug,
  authorization id, connection status).
- Executed buy/sell order metadata (symbol, side, quantity, price, timestamp,
  brokerage order id) needed to render group alerts.
- Audit logs of bot commands and webhook events for security/debugging.

## What we do not collect

- Brokerage usernames, passwords, MFA codes, or session tokens. SnapTrade
  handles all brokerage authentication; we never see those credentials.
- Funding, balance, position, or tax data beyond what is needed to render
  alerts.
- Trading authority. All connections are forced read-only.

## How we use it

- To render trade alerts to the Telegram group(s) you joined, at the privacy
  level you selected.
- To operate, secure, and debug the service.

## Sharing

- SnapTrade processes brokerage data on our behalf. See SnapTrade's privacy
  policy at https://snaptrade.com.
- Telegram receives the rendered alert text (no secrets).
- We do not sell personal data.

## Retention

- Data is retained while your account is active.
- `/disconnect confirm` disables syncing and group sharing and attempts to
  revoke brokerage authorizations. It does not itself delete all retained
  account content.
- `DELETE /account/delete` (operator-initiated) immediately disables syncing
  and sharing, removes queued jobs, deletes user-scoped memberships,
  connections/accounts, sync state, trades/alerts, and audit logs, and clears
  the Telegram identifier and SnapTrade credentials before asking SnapTrade to
  delete its user.
- SnapTrade deletion is asynchronous. When a provider identity exists, we
  temporarily retain only a PII-minimized local record with an opaque id and
  lifecycle state, plus a provider deletion tombstone containing the provider
  user id needed for retry and confirmation. Provider HTTP acceptance means
  the request is pending, not complete. `READY` failures and `PENDING` requests
  older than 24 hours are retried; the remaining local record and tombstone are
  removed only after a valid signed `USER_DELETED` webhook or an authoritative
  provider `404` from deleting that exact generation-scoped identity.
- To prevent delayed Telegram updates from recreating a deleted account, we
  retain a keyed, non-reversible hash of the Telegram user ID plus deletion,
  completion, and optional reactivation ordering timestamps for up to 90 days.
  It is used only to reject pre-deletion updates and can be reactivated only by
  a newer private `/start`. The raw Telegram ID is not retained in this record;
  the opaque local deletion id is cleared at completion, and the suppression
  record expires automatically.
- If provider credentials are inconsistent and no provider user id is
  available, content and Telegram identity are still scrubbed, but a minimal
  blocked record may be retained for manual resolution. If no provider
  identity or credential exists, local deletion completes immediately.

## Security

- AES-256-GCM encryption of SnapTrade user secrets at rest.
- HMAC SHA-256 verification of SnapTrade webhooks, a 24-hour signed retry
  horizon, and durable canonical-event replay protection.
- Secret-token verification of Telegram webhooks.
- TLS in transit.

## Your rights

You may request access, correction, export, or deletion by contacting the
operator. We respond within a reasonable timeframe and within any deadlines
required by applicable law (GDPR/CCPA where applicable).

## Children

The service is not directed to children under 18.

## Changes

We may update this policy. Material changes will be announced in the group
where the bot operates.

## Contact

Contact the operator listed in the Telegram group or repository.
