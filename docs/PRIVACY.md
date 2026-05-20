# Privacy Policy — TradePing Bot

_Last updated: 2026-05-20. Replace with counsel-reviewed text before public launch._

## What we collect

- Telegram user id, display name/username, and group chat ids you interact with.
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
- `/disconnect` revokes brokerage authorizations.
- `DELETE /account/delete` (operator-initiated) removes your user record and
  cascades broker connections, accounts, trade events, and alerts.

## Security

- AES-256-GCM encryption of SnapTrade user secrets at rest.
- HMAC SHA-256 verification of SnapTrade webhooks plus 5-minute replay window.
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
