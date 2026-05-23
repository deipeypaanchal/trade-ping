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
    expect(out).toEqual({ symbol: 'COIN', symbolId: 'sym-coin', quantity: 5, price: 231.368, marketPrice: undefined, openPnl: undefined, currency: 'USD' });
  });

  it('normalizes unified SnapTrade position shapes', () => {
    const out = svc.normalizePosition({
      instrument: { id: 'sym-aapl', symbol: 'AAPL', currency: 'USD', kind: 'stock' },
      units: '1.25',
      price: '301.10',
      cost_basis: '299.95',
    });

    expect(out).toEqual({ symbol: 'AAPL', symbolId: 'sym-aapl', quantity: 1.25, price: 299.95, marketPrice: 301.1, openPnl: undefined, currency: 'USD' });
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
    expect(first?.price).toBe(231.368);
    expect(first?.priceSource).toBe('POSITION_COST_BASIS');
    expect(first?.rawStatus).toBe('INFERRED');
    expect(second?.dedupeHash).toBe(first?.dedupeHash);
  });

  it('NEVER renders order.price (limit) as a fill price', () => {
    // Some brokers expose order.price as the limit price even after execution.
    // The detector must treat it as a limit, not as the fill we rendered to users.
    const out = svc.normalizeOrder('u1', 'a1', {
      brokerage_order_id: 'o1',
      status: 'EXECUTED',
      action: 'BUY',
      universal_symbol: { symbol: 'AAPL' },
      filled_quantity: 1,
      price: 999.99, // limit
    });
    expect(out?.price).toBeUndefined(); // no fill available — renderer should say "price unavailable"
    expect(out?.limitPrice).toBe(999.99);
  });

  it('prefers average_fill_price over execution_price', () => {
    const out = svc.normalizeOrder('u1', 'a1', {
      brokerage_order_id: 'o1',
      status: 'EXECUTED',
      action: 'BUY',
      universal_symbol: { symbol: 'AAPL' },
      filled_quantity: 1,
      average_fill_price: 100.5,
      execution_price: 101.0,
    });
    expect(out?.price).toBe(100.5);
    expect(out?.averageFillPrice).toBe(100.5);
    expect(out?.executionPrice).toBe(101.0);
  });

  it('extracts option metadata when option_symbol is present', () => {
    const out = svc.normalizeOrder('u1', 'a1', {
      brokerage_order_id: 'o-opt-1',
      status: 'EXECUTED',
      action: 'BUY',
      filled_quantity: 1,
      average_fill_price: 5.23,
      option_symbol: {
        ticker: 'AAPL  250321C00150000',
        symbol: 'AAPL',
        underlying_symbol: { symbol: 'AAPL' },
        expiration_date: '2025-03-21',
        strike_price: 150,
        option_type: 'CALL',
      },
      filled_date: '2026-01-01T10:00:00Z',
    });
    expect(out?.assetType).toBe('OPTION');
    expect(out?.symbol).toBe('AAPL  250321C00150000');
    expect(out?.underlying).toBe('AAPL');
    expect(out?.optionExpiration).toBe('2025-03-21');
    expect(out?.optionStrike).toBe(150);
    expect(out?.optionType).toBe('CALL');
  });

  it('classifies plain equities as EQUITY', () => {
    const out = svc.normalizeOrder('u1', 'a1', {
      brokerage_order_id: 'o1',
      status: 'EXECUTED',
      action: 'BUY',
      universal_symbol: { symbol: 'AAPL' },
      filled_quantity: 1,
      average_fill_price: 100,
    });
    expect(out?.assetType).toBe('EQUITY');
    expect(out?.underlying).toBeUndefined();
  });
});
