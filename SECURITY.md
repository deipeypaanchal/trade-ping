# Security Policy

## Supported Versions

TradePing is pre-1.0. Security fixes are applied to `main`.

## Reporting A Vulnerability

Please do not open a public issue for vulnerabilities or leaked secrets.

Use a private GitHub security advisory when possible:

https://github.com/deipeypaanchal/trade-ping/security/advisories/new

Include:

- A short description.
- Affected endpoint or file.
- Reproduction steps.
- Impact and any suggested fix.
- Whether you accessed only your own account/test data.

Expected response:

- Acknowledgement within 72 hours.
- Triage update within 7 days for valid reports.
- Coordinated disclosure after a fix is available.

## Bug Bounty

TradePing does not currently run a paid bug bounty program. Good-faith security reports are welcome and will be credited when the reporter wants public credit.

In scope:

- Authentication or authorization bypass.
- Secret exposure in code, logs, CI, or deployment config.
- Unauthorized access to another user's TradePing connection state.
- Telegram webhook spoofing, SnapTrade webhook replay, or job endpoint bypass.
- Privacy leaks across Telegram groups or users.

Out of scope:

- Social engineering, phishing, spam, or denial-of-service testing.
- Accessing accounts, trades, tokens, or personal data that you do not own.
- Broker-side or SnapTrade-side issues that TradePing cannot control.
- Reports that require write/trading access. TradePing must remain read-only.

Safe harbor applies only to good-faith testing that avoids privacy harm, data destruction, persistence, service disruption, and trading activity.

## Sensitive Data

Never commit or paste:

- Telegram bot tokens.
- SnapTrade consumer keys.
- `ENCRYPTION_KEY_BASE64`.
- `INTERNAL_JOB_SECRET`.
- Database or Redis URLs.
- SnapTrade user secrets.
- Raw brokerage credentials or MFA details.

## Security Design

- SnapTrade connections are forced to read-only mode.
- Brokerage credentials are handled by SnapTrade, not TradePing.
- SnapTrade user secrets are encrypted at rest with AES-256-GCM.
- Telegram webhooks require a secret token header.
- SnapTrade webhooks require HMAC verification and replay checks.
- Internal job endpoints require a bearer token.

## Operational Notes

Rotate credentials immediately if they are exposed in chat, logs, screenshots, or commits.
