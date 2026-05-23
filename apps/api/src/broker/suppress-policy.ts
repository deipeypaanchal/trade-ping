/**
 * Pure suppression policy. Decides whether a normalized trade should be
 * persisted as BACKFILL/SKIPPED (no alert) or NEW/PENDING (alert eligible).
 *
 * The policy is intentionally a small, total function so the truth table
 * can be exhaustively tested. If you need a new rule, add it here — never
 * inline a boolean check at the call site.
 */

export type SuppressInput = {
  /** Wall-clock time of the trade. */
  tradeTime: Date;
  /** True iff this is the first time we've ever synced this (user, account). */
  isFirstSync: boolean;
  /** Caller explicitly asked for a quiet sync (e.g. manual replay). */
  suppressBackfill: boolean;
  /** Configured "anything older than this is backfill" window. */
  backfillSuppressHours: number;
  /** Last time we successfully synced this account, if any. Used to widen
   *  the suppression window when the worker was offline for longer than
   *  the static backfill window. Prevents re-alerting trades that were
   *  already alerted before a long outage. */
  lastSuccessfulSyncAt?: Date | null;
  /** Now, injected for deterministic tests. */
  now?: Date;
};

export type SuppressDecision = {
  suppress: boolean;
  reason: 'suppress_backfill_flag' | 'first_sync' | 'older_than_backfill_window' | 'older_than_last_sync' | 'fresh';
};

export function shouldSuppressAlert(input: SuppressInput): SuppressDecision {
  if (input.suppressBackfill) return { suppress: true, reason: 'suppress_backfill_flag' };
  if (input.isFirstSync) return { suppress: true, reason: 'first_sync' };

  const now = (input.now ?? new Date()).getTime();
  const tradeMs = input.tradeTime.getTime();
  const backfillCutoff = now - input.backfillSuppressHours * 3_600_000;

  // Take the EARLIER of (now − backfillHours) and the last successful sync.
  // If the bot was offline for longer than the static window, trades from
  // the outage window have already been alerted in the previous run; cut
  // them out so a restart doesn't replay them.
  const lastSyncMs = input.lastSuccessfulSyncAt?.getTime();
  const effectiveCutoff = lastSyncMs !== undefined ? Math.max(backfillCutoff, lastSyncMs) : backfillCutoff;

  if (tradeMs < effectiveCutoff) {
    return { suppress: true, reason: lastSyncMs !== undefined && lastSyncMs > backfillCutoff ? 'older_than_last_sync' : 'older_than_backfill_window' };
  }
  return { suppress: false, reason: 'fresh' };
}
