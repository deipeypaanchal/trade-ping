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
  it('dedupes provider order ids even when provider timestamps move', () => {
    const first = svc.normalizeOrder('u1', 'a1', { brokerage_order_id: 'o1', status: 'EXECUTED', action: 'SELL', universal_symbol: { symbol: 'TTWO' }, filled_quantity: 1, filled_date: '2026-01-01T10:00:00Z' });
    const second = svc.normalizeOrder('u1', 'a1', { brokerage_order_id: 'o1', status: 'EXECUTED', action: 'SELL', universal_symbol: { symbol: 'TTWO' }, filled_quantity: 1, filled_date: '2026-01-01T10:03:00Z' });
    expect(second?.dedupeHash).toBe(first?.dedupeHash);
  });
});
