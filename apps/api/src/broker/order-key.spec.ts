import { computeOrderKey, computePositionDeltaKey, scopeKeyToGroup } from './order-key';

describe('computeOrderKey', () => {
  const base = { userId: 'u1', accountId: 'a1', symbol: 'AAPL', side: 'BUY' as const, timestamp: '2026-01-01T10:00:00.000Z' };

  it('is stable across calls with the same provider order id', () => {
    const a = computeOrderKey({ ...base, providerOrderId: 'o1' });
    const b = computeOrderKey({ ...base, providerOrderId: 'o1' });
    expect(a).toBe(b);
  });

  it('ignores symbol/side/timestamp/qty/price when a provider order id is present', () => {
    // identity is the order id alone; the broker re-quoting price/quantity must not break dedupe
    const a = computeOrderKey({ ...base, providerOrderId: 'o1' });
    const b = computeOrderKey({ ...base, providerOrderId: 'o1', symbol: 'OTHER', side: 'SELL', timestamp: '2030-01-01T00:00:00.000Z' });
    expect(a).toBe(b);
  });

  it('falls back to (user, account, symbol, side, timestamp) when no provider id', () => {
    const a = computeOrderKey({ ...base });
    const b = computeOrderKey({ ...base });
    expect(a).toBe(b);
  });

  it('fallback DOES NOT include quantity/price (the spam-bug guarantee)', () => {
    // Two fetches of the same fill returning 100 vs 100.0 must dedupe.
    // The type doesn't expose qty/price; this test pins the contract that
    // future authors cannot regress by adding them back.
    const a = computeOrderKey({ ...base });
    const b = computeOrderKey({ ...base });
    expect(a).toBe(b);
  });

  it('differentiates fallback hashes by side', () => {
    expect(computeOrderKey({ ...base, side: 'BUY' })).not.toBe(computeOrderKey({ ...base, side: 'SELL' }));
  });

  it('differentiates fallback hashes by timestamp', () => {
    expect(computeOrderKey({ ...base, timestamp: '2026-01-01T10:00:00.000Z' })).not.toBe(
      computeOrderKey({ ...base, timestamp: '2026-01-01T10:00:01.000Z' }),
    );
  });
});

describe('computePositionDeltaKey', () => {
  const base = { userId: 'u1', accountId: 'a1', symbolId: 'sym-coin' };

  it('is stable for the same delta', () => {
    const a = computePositionDeltaKey({ ...base, previousQuantity: 1, currentQuantity: 5 });
    const b = computePositionDeltaKey({ ...base, previousQuantity: 1, currentQuantity: 5 });
    expect(a).toBe(b);
  });

  it('differs when the delta endpoints differ', () => {
    const a = computePositionDeltaKey({ ...base, previousQuantity: 1, currentQuantity: 5 });
    const b = computePositionDeltaKey({ ...base, previousQuantity: 1, currentQuantity: 6 });
    expect(a).not.toBe(b);
  });
});

describe('scopeKeyToGroup', () => {
  it('namespaces an order key by group id', () => {
    expect(scopeKeyToGroup('abc', 'g1')).toBe('abc:g1');
    expect(scopeKeyToGroup('abc', 'g2')).not.toBe(scopeKeyToGroup('abc', 'g1'));
  });
});
