# TradePing — Detailed Code Review (Pre-Beta)

Reviewer: acting solo engineering team.
Scope: full repo, with a focus on correctness under 10–25 concurrent beta users and forward-readiness for 100+.
Method: line-by-line read of every source file, schema, config, and external API contract (SnapTrade + Telegram docs cross-checked).

Severity legend:
- **P0 — blocker, must fix before any real credentials are wired**
- **P1 — required before opening the bot to non-internal users**
- **P2 — required before public/wider launch**
- **P3 — improvement, defer if time-boxed**

> Many P0/P1 items below were **already fixed in this review pass**. They are listed with status `FIXED` for traceability, and the remaining open items are at the end.

---

## 1. External API alignment

### 1.1 SnapTrade authentication — `P0 FIXED`

**Problem.** `apps/api/src/snaptrade/snaptrade.service.ts` (pre-review) sent requests with `SnapTrade-Client-Id` and `SnapTrade-Consumer-Key` headers. SnapTrade does **not** accept that scheme. Per <https://docs.snaptrade.com/docs/request-signatures>, every request must include:

- `clientId` and `timestamp` (unix seconds) as **query params**, and
- a `Signature` header containing `base64(HMAC-SHA256(consumerKey, canonical_json({content,path,query})))` with keys sorted, no whitespace, and `null` for empty bodies.

Without this, every SnapTrade call would have returned 401 and the entire onboarding/sync flow would have been silently broken on first contact with real credentials. (The local `SNAPTRADE_USE_MOCK=true` path hid this in dev.)

**Fix.** Replaced the hand-rolled fetch layer with the official `snaptrade-typescript-sdk` (v9.0.200), which generates signatures automatically and is the path SnapTrade officially recommends. Public method surface kept identical (`registerUser`, `connectionPortal`, `listConnections`, `deleteConnection`, `listAccounts`, `listAccountOrders`) so nothing else changed. Added `refreshConnection(...)` for use on `CONNECTION_ADDED`.

**Verification.** `pnpm build` + `pnpm test` green. Live verification requires the real `SNAPTRADE_CLIENT_ID` / `SNAPTRADE_CONSUMER_KEY` — once set, the `snaptrade.apiStatus.check()` smoke test in §11 of the deployment guide will confirm.

### 1.2 SnapTrade webhook signature — `OK`

`snaptrade-webhook.controller.ts` verifies the `Signature` header as `base64(HMAC-SHA256(consumerKey, rawBody))` and rejects events older than 5 minutes. Cross-checked against the Python sample in <https://docs.snaptrade.com/docs/webhooks#verifying-webhook-authenticity> — identical algorithm. The raw body capture in `main.ts` (`express.json({ verify })`) preserves the exact bytes SnapTrade signed, so signatures will match.

Edge case worth knowing: the SnapTrade docs' TypeScript sample wraps the consumer key with `encodeURI(...)` while the Python sample does not. The webhook signing always uses the raw key (matches the Python sample); the SDK handles request signing for us. No change required.

### 1.3 SnapTrade webhook event coverage — `P1 FIXED`

Before: every authenticated webhook simply enqueued a generic sync for the user, regardless of event type.

After: the controller now branches on `eventType`:

| Event | Action |
| --- | --- |
| `USER_DELETED` | Local user row removed (cascade clears state). |
| `CONNECTION_DELETED` | Local connection status flipped to `DISCONNECTED`. |
| `CONNECTION_BROKEN` | Status flipped to `ERROR`, `disabledReason` set. |
| `ACCOUNT_HOLDINGS_UPDATED`, `ACCOUNT_TRANSACTIONS_*`, `TRADE_DETECTION`, `TRADE_UPDATE`, `NEW_ACCOUNT_AVAILABLE`, `CONNECTION_ADDED`, `CONNECTION_FIXED`, `CONNECTION_UPDATED` | Enqueue `sync-user` with `jobId: sync-user:<id>` so duplicate webhooks coalesce. |
| Any other (e.g. `USER_REGISTERED`, `CONNECTION_ATTEMPTED`, `CONNECTION_FAILED`, `ACCOUNT_REMOVED`) | Audited only — no enqueue. |

This avoids waking the worker for events that produce no new trades, and keeps the bot consistent with SnapTrade's lifecycle events.

### 1.4 Telegram API alignment — `P1 FIXED`

Telegram limits (<https://core.telegram.org/bots/faq#broadcasting-to-users>):

- Per chat: **≤ 1 msg/second**.
- Per group: **≤ 20 msg/minute**.
- Global: **~30 msg/second**.

Pre-review `TelegramService.sendMessage` had no limiter and no 429 handling. With 20 users in one group, ~10 simultaneous executions = burst of 10 messages to one chat = guaranteed 429 from Telegram, and the failure flips `alertStatus = FAILED` and surfaces as a 5xx out of the queue worker.

**Fix.** `TelegramService` now uses `Bottleneck.Group` with `minTime: 1100` and a per-minute reservoir of 20, chained to a global limiter of 25 req/sec. `sendMessage` also retries once on HTTP 429, honoring `parameters.retry_after`. Code: [apps/api/src/telegram/telegram.service.ts](../apps/api/src/telegram/telegram.service.ts).

### 1.5 Telegram webhook secret — `OK`

`X-Telegram-Bot-Api-Secret-Token` is verified in `TelegramController.webhook` with a constant `UnauthorizedException` on mismatch. The `setWebhook` helper passes the same secret. No issue.

---

## 2. Concurrency, queues, and scale

### 2.1 `/sync` ran synchronously in the Telegram webhook handler — `P1 FIXED`

Pre-review, `/sync` called `BrokerSyncService.syncUser(...)` inline. With one connection and three accounts, that is two SnapTrade roundtrips plus N order calls plus an alert send per trade — easily 5–15 seconds. Telegram considers webhook responses slow after ~5s and retries the update after 60s, which would cause duplicate processing (the bot is idempotent enough to survive this, but it still wastes calls and spawns extra alerts during retry).

**Fix.** `/sync` now enqueues a deduped `sync-user` BullMQ job and immediately replies "Sync queued." in the chat.

### 2.2 Worker concurrency + rate limiter — `P1 FIXED`

`TradeSyncProcessor` was using default Worker options (concurrency 1, no limiter). Two issues:

- Under bursty webhook traffic, the queue could back up because every job ran serially regardless of SnapTrade headroom.
- Without an upper bound, a misbehaving cron could fire hundreds of jobs and trip SnapTrade rate limits, which currently has no retry logic in `BrokerSyncService.syncAll`.

**Fix.** `@Processor('trade-sync', { concurrency: 2, limiter: { max: 30, duration: 60_000 } })` — two parallel user syncs at a time, capped at 30 jobs/minute per worker process. Defaults chosen conservatively for SnapTrade's standard plan; the constants are easy to lift to env vars later. Code: [apps/api/src/workers/trade-sync.processor.ts](../apps/api/src/workers/trade-sync.processor.ts).

### 2.3 `BrokerSyncService.syncAll` is serial — `P2 OPEN`

```ts
for (const u of users) { try { await this.syncUser(u.id); } catch { ... } }
```

Fine for 25 users (~25 × 2s = 50s). At 100 users with brokerage roundtrips this becomes minutes. When scaling past 50, replace the serial loop with an enqueue (one `sync-user` per user) so the BullMQ worker pool naturally parallelises them within the rate limiter:

```ts
for (const u of users) await this.queue.add('sync-user', { userId: u.id }, { jobId: `sync-user:${u.id}` });
```

That also gives free retry/backoff per user.

### 2.4 `syncUser` is not idempotent against concurrent runs from itself — `P2 OPEN`

Within a single `syncUser` call we walk connections → accounts → orders sequentially, which is fine. But if SnapTrade fires two webhooks for the same user within milliseconds, BullMQ will only coalesce them if both arrive while the first is still queued. Once one starts running, the next will queue and re-execute. This is mostly harmless because the `dedupeHash` on `TradeEvent` blocks double-alerts at the DB level (Postgres unique constraint), but it does waste SnapTrade calls.

If this becomes a measurable cost, add a Redis-backed advisory lock in `BrokerSyncService.syncUser` (`SET sync:<userId> NX PX 60000`) and bail out if held.

### 2.5 `dedupeHash` scoping — `OK`

`broker-sync.service.ts` stores `${norm.dedupeHash}:${member.groupId}` as the unique key. This is correct: a user in two groups should generate one alert **per group**, not one total. The hash itself is computed from `(userId, accountId, rawId, symbol, side, quantity, price, timestamp)` which is stable across syncs.

Subtle gotcha that's currently fine: if SnapTrade ever changes the precision of `average_fill_price` between two snapshots of the same order (e.g. `123.45` → `123.4500`), the dedupe hash changes and you'd get a duplicate alert. Risk is theoretical for filled equity orders but real for partials. If you see duplicates in beta, switch to `(userId, accountId, rawId)` only.

### 2.6 Backfill suppression — `OK with a one-time edge case`

`shouldSuppressAsBackfill` returns true if there's no `SyncState` row AND the trade is older than `BACKFILL_SUPPRESS_HOURS` (default 24h). After the first sync, the `SyncState` row exists and nothing is suppressed anymore.

Edge case: if a user connects at 9:00am, runs `/sync`, and a real execution from 8:30am the same day arrives in the very first sync, it **will** be alerted (it's inside the 24h window). That's usually desired — early morning trades on connection day shouldn't be hidden — but flag it to beta users in the welcome message so nobody is surprised.

### 2.7 BullMQ Redis client reuse — `OK`

`AppModule` builds the BullMQ connection once via `BullModule.forRootAsync`. Each `BullModule.registerQueue({ name: 'trade-sync' })` (in `snaptrade.module.ts`, `workers.module.ts`, `telegram.module.ts`) reuses that connection. No connection leak.

---

## 3. Security

### 3.1 Encryption at rest — `OK`

`CryptoService` uses AES-256-GCM with a 12-byte random IV per encryption, versioned payload (`v1.iv.tag.ct`), and rejects key sizes other than 32 bytes. `decrypt` will throw if the auth tag fails, which is the correct behaviour. The HMAC helper (`hmac`) uses the same key for hashing brokerage account names — that's a one-way pseudonymisation and is fine for the current use (debugging dupes without storing PII).

### 3.2 Webhook signature constant-time compare — `OK`

`safeEqual` uses `timingSafeEqual` after length check. Good.

### 3.3 Authorisation on internal endpoints — `OK`

Both `/jobs/*` and `DELETE /account/delete` require `Authorization: Bearer <INTERNAL_JOB_SECRET>`. The secret is required ≥32 chars by Zod. No other write endpoints are exposed.

### 3.4 SQL injection / Prisma — `OK`

All DB access is through Prisma's query builder. No raw SQL anywhere. Cascade deletes are set on every FK that needs them.

### 3.5 Logging hygiene — `P2 OPEN`

`Logger.error(... (err as Error).message ...)` is used in a few places, which is fine, but there's no global guarantee that secrets won't slip into a stack trace if NestJS prints one. Recommend: before public launch, install Sentry with `beforeSend` scrubbers for the env-var names listed in [DEPLOYMENT.md §3](DEPLOYMENT.md#3-environment-variables-complete-reference). The bot never logs `userSecret` directly today, but a future bug could.

### 3.6 Key rotation — `P3 OPEN` <a id="key-rotation"></a>

`ENCRYPTION_KEY_BASE64` is loaded fresh on every `encrypt`/`decrypt` call (from `process.env`). There is no support for a "previous key" envelope. If you need to rotate the key:

1. Add a `key_version` column to `User`, default `1`.
2. Add `ENCRYPTION_KEY_BASE64_V2` and update `CryptoService.key()` to pick by version.
3. Write a one-off worker that selects rows with the old version, decrypts with v1, re-encrypts with v2, and bumps the version.
4. Once 0 rows remain on v1, retire `ENCRYPTION_KEY_BASE64` (v1).

Document this **before** you publish — losing the v1 key with users still encrypted on it is unrecoverable.

### 3.7 No rate limiting on `/telegram/webhook` itself — `P3 OPEN`

If someone learns your webhook URL they can spam it, but every request without the correct `X-Telegram-Bot-Api-Secret-Token` is rejected with 401 before any work runs. CPU cost per bad request is low. If you start seeing abuse in logs, add `@nestjs/throttler` with a per-IP budget.

### 3.8 SnapTrade callback route — `OK`

`GET /snaptrade/callback` returns a static HTML page. No state read, no PII. The `mock` query param is the only input and is HTML-escaped trivially. No XSS surface.

---

## 4. Data model (Prisma)

### 4.1 Schema review — `OK with notes`

- `User.snaptradeUserId` is unique — good.
- `BrokerConnection.authorizationId` is unique — good (used as upsert key).
- `BrokerAccount @@unique([connectionId, providerAccountId])` — good.
- `TradeEvent.dedupeHash` is unique — good, prevents double inserts.
- `SyncState @@unique([userId, accountId, key])` — note that Postgres treats `NULL` as distinct in unique indexes. `accountId` is `String?`. In practice we always pass a non-null `accountId` in `markSynced`, so this is fine; but if you ever insert with `accountId: null` you can get multiple rows. Either tighten the type or add a check constraint.
- `AuditLog.metadata Json?` — perfect for forensic queries.
- `IdempotencyKey` is declared but not currently referenced from any code. Leave for now; it's a hook for a future "idempotent webhook" implementation.

### 4.2 Migration completeness — `OK`

`prisma/migrations/20260520000000_init/migration.sql` covers every table and index in the schema. `prisma migrate deploy` will apply it cleanly on an empty DB.

### 4.3 Decimal types — `OK`

`quantity` and `price` are `Decimal(65,30)` (Prisma default for `Decimal`). Slight footgun: when read back into JS via Prisma, they come back as `Decimal.js` objects, not `number`. `AlertService.render` calls `Number(event.price).toFixed(2)` — works, but loses precision past Number's range. Fine for stocks; revisit if you add fractional crypto with 18-decimal precision.

---

## 5. Telegram surface — UX correctness

### 5.1 `/connect` from a group — `OK`

If `chat.type === 'private'`, the link is posted in the same chat. Otherwise the bot DMs the user and posts a confirmation in the group. If the DM fails (user hasn't `/start`ed the bot), the bot tells them to do so. Good.

### 5.2 Privacy command — `OK with note`

`/privacy public|normal|private|off` validates the level case-insensitively. `OFF` also sets `alertsEnabled=false`. The `BadRequestException` for an unknown level is currently caught by the controller's try/catch and surfaces as "Something went wrong" — not user-friendly. Consider returning an explicit "Invalid privacy level. Use /privacy public, normal, private, or off." inline. (P3.)

### 5.3 Group join semantics — `P2 OPEN`

When the bot is added to a new group, the first message it sees triggers `Group.upsert` and `GroupMember.upsert`. That's adequate, but it means existing members in the group only become known after they speak. If you want pre-arming, listen for `my_chat_member` updates (Telegram fires this when the bot is added) and seed group state. Not blocking beta.

### 5.4 HTML escaping in alerts — `OK`

`AlertService.escape` handles `& < >`. Telegram's HTML parse mode also accepts `"` and `'` but they don't have special meaning outside of attribute values — safe.

### 5.5 Display name from username — `OK with note`

`displayName` falls back through `@username → first+last → "Telegram User"`. If a user later changes their username, the upsert in `webhook(...)` updates it on the next message. Fine.

---

## 6. Error handling and observability

### 6.1 Webhook handler swallow rate — `OK`

Both webhooks return `{ ok: true }` on success and throw `UnauthorizedException` on signature/staleness failures (which become 401). The Telegram webhook also wraps command handling in a try/catch that audits the failure and replies with a generic apology — so a one-off bug in a command doesn't make Telegram retry the update (which would spam the user).

### 6.2 Worker errors — `P2 OPEN`

`TradeSyncProcessor.process` re-throws, which is correct — BullMQ then applies exponential backoff (`attempts: 3`). However we never surface "all 3 attempts failed" to anyone. Recommendations:

- Hook the worker `failed` event to write to `AuditLog`.
- Hook into Sentry (or a Discord webhook) with the failed job's data.

### 6.3 No structured logging — `P2 OPEN`

NestJS's default `Logger` writes plain text to stdout. Fine for `railway logs`, harder for grep + alerting. Before public launch, add `pino` + `nestjs-pino` and ship logs to your log aggregator.

### 6.4 No request id propagation — `P3 OPEN`

SnapTrade attaches `x-request-id` on every response. Capturing and logging it on failures would shorten support tickets. Easy add via an SDK interceptor.

---

## 7. Tests

Existing: 5 suites, 9 tests covering env validation, crypto round-trip, stable JSON, trade detector, and webhook signature/replay.

Gaps worth filling before wider launch (all P2):

- `TelegramService` rate limiter behaviour (mock `fetch`, fire 5 sends to one chat, assert ≥4s wall time and 1 send queued at a time).
- `TelegramService` 429 retry path (mock 429 then 200, assert one retry).
- `BrokerSyncService.syncUser` happy path (mock the SnapTrade service + Prisma, assert dedupe hash uniqueness and `AlertService` calls).
- `SnaptradeWebhookController` event-type branching (`USER_DELETED`, `CONNECTION_DELETED`, `CONNECTION_BROKEN`, sync triggers).
- `BrokerOnboardingService.disconnectAll` swallows individual delete failures but still flips local state — assert.

A nice-to-have: a contract test that spins up `SnaptradeService` with `SNAPTRADE_USE_MOCK=true` and asserts the SDK call-shape matches what the rest of the code expects.

---

## 8. Build, lint, CI

### 8.1 Lint glob on Windows — `FIXED`

`eslint 'src/**/*.ts'` failed under PowerShell (quotes weren't stripped, glob never expanded). Changed to `eslint src` which lets ESLint do its own glob via the config.

### 8.2 CI runs `db:generate` before lint/test — `FIXED`

Without this, Prisma's generated types aren't on disk and would cause spurious failures if we ever start type-checking in CI.

### 8.3 Docker image build is unverified locally — `P2 OPEN`

Run `docker build -t tradeping .` on the deploy host before the first deploy. The Dockerfile is structured correctly (multi-stage, copies `prisma` into the runner stage, runs as non-root if you add `USER node` — recommended).

### 8.4 No security scanner in CI — `P3 OPEN`

Add `pnpm audit --audit-level=high` (or `npm audit`) to the workflow before `pnpm test`. For images, add Trivy or Snyk if you formalise a deploy pipeline.

---

## 9. Product-level review

### 9.1 No copy-trading or follower features — `OK and intentional`

The bot is read-only by design. The `connectionType: 'read'` is hard-coded in `connectionPortal(...)`. No code path can create a trade-capable connection. Keep it that way; the moment you ship a "/copy" command you become a regulated entity in most jurisdictions.

### 9.2 No leaderboards / public rankings — `OK and intentional`

Aggregations would create FINRA/SEC-style "investment adviser" exposure. The schema supports per-trade alerts only.

### 9.3 Disclaimer in every alert — `OK`

`AlertService.render` always appends a compact broker-confirmed, read-only, not-financial-advice footer. Mirrors `docs/DISCLAIMER.md`.

### 9.4 User comprehension — `P2 OPEN`

Onboarding text is terse. Before adding non-friends to the beta:

1. Add a longer `/start` text that explains the privacy levels and what data is shared.
2. Add `/help` examples for each command.
3. In the group, post a pinned "what this bot does and does not do" message.

### 9.5 GDPR / CCPA — `P2 OPEN`

`DELETE /account/delete` exists and works, but it's gated by `INTERNAL_JOB_SECRET` — i.e. the operator must run it on the user's behalf. For wider launch, expose a self-service path:

- New Telegram command `/delete` that requires the user to type `/delete confirm` within 60s and then calls the same logic.
- Email-based self-service if you ever add an email channel.

### 9.6 Brokerage variety — `P3 OPEN`

The code is brokerage-agnostic; `SNAPTRADE_BROKER_SLUG` lets you scope the portal to one brokerage if you want a clean MVP. For beta, leaving it unset (full picker) is fine. Just confirm in the SnapTrade dashboard that the brokerages you want are toggled on.

---

## 10. What's left before opening wider beta

In priority order. Each line is small (hours, not days) unless noted.

1. **Provide credentials and deploy.** Walk through [docs/DEPLOYMENT.md](DEPLOYMENT.md) end-to-end. Smoke tests in §11 must all pass.
2. **Connect one real Robinhood account** and confirm a live trade alert renders correctly and that backfill suppression silenced old orders. (No code change — just real-world validation.)
3. **Add `/sync` ack copy improvements + `/delete confirm` flow.** (P2 §9.5, §5.2.)
4. **Sentry (or Datadog logs) + a `failed`-job alert.** (P2 §6.2, §6.3.) Wire to a Telegram admin chat for instant visibility.
5. **Counsel review of `docs/TERMS.md`, `docs/PRIVACY.md`, `docs/DISCLAIMER.md`.** Replace contact placeholders with a real operator address.
6. **Add tests listed in §7** to lock in behaviour as you onboard testers.
7. **Move `syncAll` to per-user enqueue (§2.3)** when you cross ~50 users.
8. **Document `ENCRYPTION_KEY_BASE64` rotation procedure (§3.6)** internally — even if you never need it, having the runbook means you can rotate if it leaks.

---

## 11. What is ready

- All API integrations are now wired through the official SnapTrade SDK (correctly signed) and a rate-limited, 429-aware Telegram client.
- Webhook signatures (Telegram + SnapTrade) are verified, with replay-window protection.
- SnapTrade event types are handled distinctly (USER_DELETED, CONNECTION_*, trades).
- Encryption at rest, cascade deletes, audit log, and read-only connection enforcement are correct.
- Background worker bounded by concurrency + per-minute rate limit.
- Prisma schema + initial migration are complete; `pnpm db:deploy` will apply cleanly.
- CI runs lint + tests + build on every push; build is reproducible via the included Dockerfile.
- Lint, tests (9/9), and build are green on the current branch.

The product is, with credentials and a successful smoke test against a real brokerage, ready for a closed beta of 10–25 users. The open P2 items above are not blockers for that, but they are blockers for "public, anyone-can-join" rollout.
