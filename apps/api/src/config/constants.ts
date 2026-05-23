/**
 * Centralized tunables. Prefer these over inline magic numbers so the wider team
 * has a single place to change throttling, retries, and time windows.
 */

export const LIMITS = {
  /** Telegram: min ms between two sends to the same chat (per-chat 1 msg/s + headroom). */
  TELEGRAM_PER_CHAT_MIN_TIME_MS: 1100,
  /** Telegram per-chat reservoir / window (20 msgs / 60s for groups). */
  TELEGRAM_PER_CHAT_RESERVOIR: 20,
  TELEGRAM_PER_CHAT_RESERVOIR_REFRESH_MS: 60_000,
  /** Telegram global cap (~30/s for bulk; leave headroom). */
  TELEGRAM_GLOBAL_RESERVOIR: 25,
  TELEGRAM_GLOBAL_RESERVOIR_REFRESH_MS: 1_000,
  TELEGRAM_GLOBAL_MAX_CONCURRENT: 5,
  /** Max retries on Telegram 429. */
  TELEGRAM_MAX_RETRIES: 2,
  /** Default safety margin added to Telegram retry_after. */
  TELEGRAM_RETRY_AFTER_PADDING_S: 0.2,
} as const;

export const WEBHOOK = {
  /** Maximum age of a SnapTrade webhook (replay protection). */
  REPLAY_WINDOW_MS: 5 * 60_000,
  /** How long to remember a SnapTrade event signature for replay-rejection. */
  IDEMPOTENCY_TTL_MS: 10 * 60_000,
} as const;

export const SYNC = {
  /** BullMQ worker concurrency for the trade-sync queue. */
  CONCURRENCY: 2,
  /** Rate limiter window for trade-sync jobs. */
  RATE_LIMIT_MAX: 30,
  RATE_LIMIT_DURATION_MS: 60_000,
  /** Fan-out dedupe window for sync-user jobs. */
  FANOUT_DEDUPE_WINDOW_MS: 60_000,
} as const;

export const JOB_DEFAULTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: 100,
  removeOnFail: 500,
} as const;

export const TIME = {
  /** Fallback timezone when User.timeZone is not set. */
  DEFAULT_TIMEZONE: 'UTC',
} as const;

export const ALERT = {
  /** Stop retrying a PENDING trade alert after this many attempts. Prevents
   *  Telegram-outage trades from cycling forever and replaying old fills. */
  MAX_ATTEMPTS: 8,
  /** Or after this much wall-clock time since the trade fired — whichever first. */
  MAX_AGE_MS: 48 * 60 * 60 * 1000,
} as const;

export const AUTO_SYNC = {
  /** On boot, only kick an immediate sync if the previous one was longer ago
   *  than this. Avoids re-firing a sync on every container restart, which
   *  is the #1 cause of "the bot spammed when we deployed". */
  BOOT_SKIP_IF_RECENT_MS: 2 * 60 * 1000,
  /** Delay before the boot sync so we don't race the rest of the app coming up. */
  BOOT_INITIAL_DELAY_MS: 30 * 1000,
} as const;
