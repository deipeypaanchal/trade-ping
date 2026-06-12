## Summary

What changed and why?

## Validation

- [ ] `corepack pnpm scripts:check`
- [ ] `corepack pnpm lint`
- [ ] `corepack pnpm test`
- [ ] `corepack pnpm build`
- [ ] `docker build -t tradeping-api:ci .` when Docker/runtime files changed

## Product and Safety

- [ ] No Telegram bot tokens, SnapTrade keys, database URLs, raw webhook payloads, account numbers, or broker credentials are included.
- [ ] Trade alerts still distinguish broker-confirmed, delayed, and provisional holdings events.
- [ ] Privacy behavior is unchanged or documented.
- [ ] Message copy changes are reflected in `docs/MESSAGE_CATALOG.md`.
- [ ] Prisma migrations are included for schema changes.

## Deployment Notes

Anything operators need to know before shipping?
