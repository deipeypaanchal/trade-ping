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
  /** Bound each Telegram HTTP request independently of any caller deadline. */
  TELEGRAM_REQUEST_TIMEOUT_MS: 15_000,
  /** Keep an outbound delivery inside the five-minute database safety fence. */
  TELEGRAM_MAX_RETRY_AFTER_S: 60,
} as const;

export const WEBHOOK = {
  /** Accept delayed signed provider retries, including deletion confirmations. */
  REPLAY_WINDOW_MS: 24 * 60 * 60_000,
  /** Permit small provider/server clock skew while rejecting future-dated replays. */
  FUTURE_TOLERANCE_MS: 60_000,
  /** Outlive the acceptance window so a canonical signed event runs once. */
  IDEMPOTENCY_TTL_MS: 7 * 24 * 60 * 60_000,
  /** A crashed handler becomes reclaimable after this bounded lease. */
  PROCESSING_LEASE_MS: 3 * 60_000,
  /** Webhooks should not occupy a database connection indefinitely waiting for a fence. */
  FENCE_MAX_WAIT_MS: 30_000,
  /** Bounds lock wait, one provider request, queueing, and transactional writes. */
  FENCE_TIMEOUT_MS: 2 * 60_000,
} as const;

export const SYNC = {
  /** One active user sync leaves database-pool headroom for the lifecycle and
   * delivery fences plus health checks in the combined beta process. */
  CONCURRENCY: 1,
  /** Rate limiter window for trade-sync jobs. */
  RATE_LIMIT_MAX: 30,
  RATE_LIMIT_DURATION_MS: 60_000,
  /** Fan-out dedupe window for sync-user jobs. */
  FANOUT_DEDUPE_WINDOW_MS: 60_000,
  /** Axios timeout applied to every SnapTrade SDK request. */
  SNAPTRADE_REQUEST_TIMEOUT_MS: 30_000,
  /**
   * Cooperative sync budget, measured before the advisory-lock transaction is
   * opened. The remaining seven minutes of the transaction timeout cover one
   * bounded delivery-fence wait, one in-flight provider timeout, and database
   * cleanup without allowing work to escape the sync lock.
   */
  MAX_RUN_MS: 8 * 60_000,
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
  /**
   * Absolute budget for lock acquisition, Telegram queueing/retries, and send.
   * This leaves one minute for final database writes before the five-minute
   * delivery-fence transaction expires.
   */
  DELIVERY_MAX_RUN_MS: 4 * 60_000,
  /** Stop retrying a PENDING trade alert after this many attempts. Prevents
   *  Telegram-outage trades from cycling forever and replaying old fills. */
  MAX_ATTEMPTS: 8,
  /** Or after this much wall-clock time since the trade fired — whichever first. */
  MAX_AGE_MS: 48 * 60 * 60 * 1000,
  /** Show the broker-received timestamp when detection materially trails execution. */
  DELAYED_FEED_THRESHOLD_MS: 15 * 60 * 1000,
  /** Provisional position alerts require a recently observed baseline so an
   *  outage recovery cannot replay old holdings drift as fresh activity. */
  PROVISIONAL_BASELINE_MAX_AGE_MS: 5 * 60 * 1000,
  /** Position deltas are timestamped when detected, not when filled. Use a
   *  wider window when checking for an already-known confirmed execution. */
  PROVISIONAL_EXECUTION_MATCH_WINDOW_MS: 15 * 60 * 1000,
  /** Give broker-confirmed executions a short chance to arrive before posting
   *  a provisional holdings alert. This prevents confusing yellow->green races
   *  for brokers whose order feed trails holdings by a few seconds. */
  PROVISIONAL_SEND_GRACE_MS: 90 * 1000,
  /** If a worker dies after claiming an alert but before finalizing it, another
   *  worker may reclaim it after this window. */
  SEND_CLAIM_STALE_MS: 5 * 60 * 1000,
} as const;

export const AUTO_SYNC = {
  /** On boot, only kick an immediate sync if the previous one was longer ago
   *  than this. Avoids re-firing a sync on every container restart, which
   *  is the #1 cause of "the bot spammed when we deployed". */
  BOOT_SKIP_IF_RECENT_MS: 2 * 60 * 1000,
  /** Delay before the boot sync so we don't race the rest of the app coming up. */
  BOOT_INITIAL_DELAY_MS: 30 * 1000,
} as const;
