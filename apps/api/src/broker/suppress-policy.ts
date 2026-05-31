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
  /** Now, injected for deterministic tests. */
  now?: Date;
};

export type SuppressDecision = {
  suppress: boolean;
  reason: 'suppress_backfill_flag' | 'first_sync' | 'older_than_backfill_window' | 'fresh';
};

export function shouldSuppressAlert(input: SuppressInput): SuppressDecision {
  if (input.suppressBackfill) return { suppress: true, reason: 'suppress_backfill_flag' };
  if (input.isFirstSync) return { suppress: true, reason: 'first_sync' };

  const now = (input.now ?? new Date()).getTime();
  const tradeMs = input.tradeTime.getTime();
  const backfillCutoff = now - input.backfillSuppressHours * 3_600_000;

  // The event dedupe hash prevents re-alerting orders already persisted before
  // an outage. Do not use the last sync time as a cutoff: delayed brokers can
  // surface a genuinely new execution hours after it happened.
  if (tradeMs < backfillCutoff) {
    return { suppress: true, reason: 'older_than_backfill_window' };
  }
  return { suppress: false, reason: 'fresh' };
}
