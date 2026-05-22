# Security Policy

## Supported Versions

TradePing is pre-1.0. Security fixes are applied to `main`.

## Reporting A Vulnerability

Please do not open a public issue for vulnerabilities or leaked secrets.

Contact the repository owner privately with:

- A short description.
- Affected endpoint or file.
- Reproduction steps.
- Impact and any suggested fix.

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
