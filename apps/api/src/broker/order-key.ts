import { createHash } from 'crypto';

/**
 * Pure dedupe-hash computation for trade events. Lives in its own module so
 * the rules are obvious, testable, and impossible to accidentally couple to
 * the rest of the sync pipeline.
 *
 * Stability rules — break these and you cause alert spam:
 *   - Identity comes ONLY from immutable identifiers (provider order id,
 *     position delta key). Never from values that the broker can re-emit
 *     with different floating-point precision (quantity, price).
 *   - The fallback path (no provider order id) uses (symbol, side, ISO timestamp).
 *     Two genuinely distinct same-second fills will collide; that is a much
 *     better failure mode than alerting twice when a broker re-quotes a fill
 *     as 100 vs 100.0.
 */

export type OrderKeyInput = {
  userId: string;
  accountId: string;
  /** brokerage_order_id (preferred) or SDK id; undefined for inferred trades. */
  providerOrderId?: string;
  /** Uppercased ticker; only used in the fallback path. */
  symbol: string;
  side: 'BUY' | 'SELL';
  /** ISO 8601 timestamp string from the broker; only used in fallback. */
  timestamp: string;
};

export type PositionDeltaKeyInput = {
  userId: string;
  accountId: string;
  /** Provider's symbol id if present, else the symbol itself. */
  symbolId: string;
  previousQuantity: number;
  currentQuantity: number;
};

export function computeOrderKey(input: OrderKeyInput): string {
  const payload = input.providerOrderId
    ? { userId: input.userId, accountId: input.accountId, providerOrderId: input.providerOrderId }
    : { userId: input.userId, accountId: input.accountId, symbol: input.symbol, side: input.side, timestamp: input.timestamp };
  return sha256(JSON.stringify(payload));
}

export function computePositionDeltaKey(input: PositionDeltaKeyInput): string {
  const rawId = `position-delta:${input.accountId}:${input.symbolId}:${input.previousQuantity}->${input.currentQuantity}`;
  return sha256(JSON.stringify({ userId: input.userId, accountId: input.accountId, rawId }));
}

/** Combine a per-order/delta hash with a group id; ensures a trade dedupes within a group, not across groups. */
export function scopeKeyToGroup(orderKey: string, groupId: string): string {
  return `${orderKey}:${groupId}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
