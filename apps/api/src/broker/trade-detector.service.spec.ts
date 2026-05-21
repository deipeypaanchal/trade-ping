import { TradeDetectorService } from './trade-detector.service';

describe('TradeDetectorService', () => {
  const svc = new TradeDetectorService();
  it('normalizes executed buy order', () => {
    const out = svc.normalizeOrder('u1', 'a1', { brokerage_order_id: 'o1', status: 'EXECUTED', action: 'BUY', universal_symbol: { symbol: 'AAPL' }, filled_quantity: 2, average_fill_price: 123.45, filled_date: '2026-01-01T10:00:00Z' });
    expect(out?.side).toBe('BUY');
    expect(out?.symbol).toBe('AAPL');
    expect(out?.quantity).toBe(2);
    expect(out?.price).toBe(123.45);
  });
  it('ignores canceled orders', () => {
    const out = svc.normalizeOrder('u1', 'a1', { brokerage_order_id: 'o1', status: 'CANCELED', action: 'BUY', universal_symbol: { symbol: 'AAPL' } });
    expect(out).toBeNull();
  });
  it('uses time_placed when filled_date is absent (Robinhood shape)', () => {
    const out = svc.normalizeOrder('u1', 'a1', { brokerage_order_id: 'o1', status: 'EXECUTED', action: 'SELL', universal_symbol: { symbol: 'TTWO' }, filled_quantity: 5, time_placed: '2026-05-18T17:22:58Z' });
    expect(out?.tradeTime.toISOString()).toBe('2026-05-18T17:22:58.000Z');
  });
  it('dedupes provider order ids even when provider timestamps move', () => {
    const first = svc.normalizeOrder('u1', 'a1', { brokerage_order_id: 'o1', status: 'EXECUTED', action: 'SELL', universal_symbol: { symbol: 'TTWO' }, filled_quantity: 1, filled_date: '2026-01-01T10:00:00Z' });
    const second = svc.normalizeOrder('u1', 'a1', { brokerage_order_id: 'o1', status: 'EXECUTED', action: 'SELL', universal_symbol: { symbol: 'TTWO' }, filled_quantity: 1, filled_date: '2026-01-01T10:03:00Z' });
    expect(second?.dedupeHash).toBe(first?.dedupeHash);
  });
  it('normalizes nested position symbols from SnapTrade positions', () => {
    const out = svc.normalizePosition({
      symbol: { symbol: { id: 'sym-coin', symbol: 'COIN' } },
      units: 5,
      average_purchase_price: '231.368',
    });
    expect(out).toEqual({ symbol: 'COIN', symbolId: 'sym-coin', quantity: 5, price: 231.368, currency: 'USD' });
  });

  it('combines whole and fractional position units when SnapTrade separates them', () => {
    const out = svc.normalizePosition({
      symbol: { symbol: { id: 'sym-aapl', symbol: 'AAPL' } },
      units: 1,
      fractional_units: '0.2393',
      average_purchase_price: '242.13',
    });

    expect(out?.quantity).toBeCloseTo(1.2393);
  });

  it('does not double count when units already includes the fractional quantity', () => {
    const out = svc.normalizePosition({
      symbol: { symbol: { id: 'sym-aapl', symbol: 'AAPL' } },
      units: '1.2393',
      fractional_units: '0.2393',
    });

    expect(out?.quantity).toBe(1.2393);
  });

  it('turns position increases into stable buy deltas', () => {
    const previous = { symbol: 'COIN', symbolId: 'sym-coin', quantity: 1, price: 200, currency: 'USD' };
    const current = { symbol: 'COIN', symbolId: 'sym-coin', quantity: 5, price: 231.368, currency: 'USD' };
    const first = svc.normalizePositionDelta('u1', 'a1', previous, current, new Date('2026-05-21T08:20:00Z'));
    const second = svc.normalizePositionDelta('u1', 'a1', previous, current, new Date('2026-05-21T08:21:00Z'));
    expect(first?.side).toBe('BUY');
    expect(first?.quantity).toBe(4);
    expect(first?.symbol).toBe('COIN');
    expect(first?.price).toBeUndefined();
    expect(first?.rawStatus).toBe('INFERRED');
    expect(second?.dedupeHash).toBe(first?.dedupeHash);
  });
});
