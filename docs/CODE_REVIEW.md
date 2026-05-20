# Code Review

## Review scope

Reviewed architecture, data model, Telegram webhook handling, SnapTrade integration layer, trade detection, alert privacy, encryption, webhook verification, worker flow, and production checklist.

## Changes made

- Forced SnapTrade Connection Portal to `connectionType: read`.
- Switched trade detection to SnapTrade account orders rather than activities because activities have stricter polling guidance.
- Added Telegram webhook secret-token verification.
- Added SnapTrade webhook HMAC signature verification and 5-minute replay window.
- Added AES-256-GCM encryption for SnapTrade user secrets.
- Added mock SnapTrade mode for local smoke tests without real credentials.
- Added `/disconnect`, `/sync`, `/status`, and `/privacy` flows.
- Added delete-account endpoint for admin-driven deletion requests.
- Added backfill suppression so old trades do not spam groups on first sync.
- Added tests for crypto, stable webhook serialization, and order normalization.

## Findings fixed

1. Original SnapTrade URL creation did not force read-only. Fixed with `connectionType: 'read'`.
2. Original Telegram messages used Markdown without escaping. Switched to HTML rendering and escaping.
3. Original webhook handling returned `{ok:false}` instead of rejecting bad Telegram secrets. Fixed with `UnauthorizedException`.
4. Original detector did not robustly filter canceled/rejected orders. Fixed by accepting only executed/filled/partial statuses.
5. Original code lacked user-controlled disconnect/delete flows. Added.
6. Original code lacked SnapTrade webhook verification. Added HMAC validation.

## Known limitations

- This repo cannot prove exact Robinhood payload shape until connected to your approved SnapTrade account.
- SnapTrade direct REST auth headers may need adjustment if your SnapTrade account requires signed request mode or SDK-only usage. The integration is isolated in `snaptrade.service.ts` so this is a one-file change.
- Near-real-time behavior depends on SnapTrade plan and brokerage freshness. The code supports webhooks and scheduled sync, but exact latency is provider-dependent.
- Production public launch still needs legal and security review.

## Final review status

Ready as a launch candidate for credential-backed sandbox deployment and private beta validation. Not certified for public brokerage-account onboarding until the launch checklist passes with real Telegram, SnapTrade, Postgres, and Redis credentials.
