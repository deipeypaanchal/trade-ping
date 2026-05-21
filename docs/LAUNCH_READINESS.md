# Launch Readiness

Last updated: 2026-05-21

## User trust model

TradePing should explain ownership in the product, not only in docs.

- Bot level: shared infrastructure and credentials: Telegram bot, SnapTrade API, Railway, Postgres, Redis, workers, and alert logic.
- User level: a member's Telegram identity, encrypted SnapTrade user secret, connected broker/accounts, detected trades/positions, and timezone.
- Group level: the Telegram group destination and the connected members in that group.
- Per-user per-group level: `/privacy` controls one member's alerts in one group. A member can be public in one group, private in another, and off elsewhere.

The `/trust` command mirrors this model in Telegram.

## Current production posture

- Hosting: Railway API service plus Railway Postgres and Redis.
- Deployment: Dockerfile image, non-root runtime user, `tini` for signal handling.
- Health: Railway health check uses `/healthz`, which verifies Postgres with `SELECT 1`.
- Liveness: `/livez` is available for a cheap process-only check.
- Jobs: BullMQ queue in Redis, worker concurrency 2, job limiter 30 jobs/minute.
- Sync: automatic `sync-all` every `SYNC_INTERVAL_MINUTES`, currently intended to be 1 minute for beta.
- Data source: SnapTrade orders first, position-delta fallback when orders are missing but holdings change. Inferred position alerts show quantity only and do not label position prices as execution fills.
- Telegram: per-chat and global Bottleneck rate limits plus 429 retry handling.

## Railway capacity read

Railway is acceptable for a small public beta if the user count is modest and the app stays single-region.

The current bottleneck is not CPU. It is external API work:

- Each connected user sync can call SnapTrade for connections, accounts, orders, and positions.
- At 1-minute polling, request volume grows roughly with connected users and accounts.
- Webhooks should be treated as the long-term realtime path, with polling as the safety net.

Recommended launch thresholds:

- 1 to 25 connected users: fine on current Railway shape.
- 25 to 100 connected users: increase `SYNC_INTERVAL_MINUTES` to 2-5, prioritize SnapTrade webhooks, and watch queue latency.
- 100+ connected users: split API and worker services, add request-level SnapTrade throttling, and add external uptime monitoring.

## Downtime risks to watch

- Railway service sleeping or restarts: keep health checks enabled and avoid relying on in-memory state.
- SnapTrade API latency or plan limits: queue retries help, but rate-limit logs should be reviewed.
- Telegram 429s: per-chat limiter protects groups, but bursts can delay alerts.
- Database availability: `/healthz` catches this before deploys go active.
- Schema drift: always run `pnpm db:deploy` after pulling migrations.
- Secrets: rotate bot/SnapTrade credentials before public launch because early setup used pasted secrets.

## Dependency audit

- High-severity production advisories: fixed with `pnpm.overrides` for `axios`, `lodash`, and `multer`.
- Remaining production advisories: 3 moderate advisories in the Nest dependency stack (`@nestjs/core` and `file-type`).
- Current risk read: acceptable for beta because TradePing does not accept user file uploads and the public surface is constrained to Telegram webhook text and SnapTrade callbacks.
- Next hardening step: plan a dedicated Nest 11 upgrade branch with expanded smoke tests instead of mixing a major framework upgrade into the launch copy/alert deploy.

## Suggested next features

- `/trust`: shipped. Explains bot/user/group boundaries.
- `/setup`: shipped. Reposts group onboarding.
- `/timezone`: shipped. Lets users control alert times.
- Admin-only `/groupstatus`: show connected member count and group alert health without exposing broker details.
- Public status page or uptime monitor: prove reliability outside Telegram.
- Staging Railway environment: test migrations and Telegram/SnapTrade webhook changes before production.
