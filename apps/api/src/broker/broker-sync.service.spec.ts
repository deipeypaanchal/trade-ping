import { BrokerSyncService } from './broker-sync.service';
import { PositionSnapshotEntry } from './trade-detector.service';

describe('BrokerSyncService position-delta guards', () => {
  const svc = new BrokerSyncService(null as never, null as never, null as never, null as never, null as never, null as never) as unknown as {
    positionChangeHealth(previous: Map<string, PositionSnapshotEntry>, current: Map<string, PositionSnapshotEntry>): string;
  };

  function map(entries: Array<Pick<PositionSnapshotEntry, 'symbol' | 'quantity'>>) {
    return new Map(entries.map((entry) => [entry.symbol, { ...entry }]));
  }

  it('suppresses likely partial holdings drops', () => {
    const previous = map([
      { symbol: 'SOL', quantity: 1 },
      { symbol: 'SHIB', quantity: 15_000_000 },
      { symbol: 'DOGE', quantity: 2500 },
      { symbol: 'BTC', quantity: 0.014 },
      { symbol: 'USDC', quantity: 22 },
    ]);
    const current = map([{ symbol: 'USDC', quantity: 22 }]);

    expect(svc.positionChangeHealth(previous, current)).toBe('PARTIAL_DROP');
  });

  it('suppresses likely rehydration after a partial snapshot', () => {
    const previous = map([{ symbol: 'USDC', quantity: 22 }]);
    const current = map([
      { symbol: 'SOL', quantity: 1 },
      { symbol: 'SHIB', quantity: 15_000_000 },
      { symbol: 'DOGE', quantity: 2500 },
      { symbol: 'BTC', quantity: 0.014 },
      { symbol: 'USDC', quantity: 22 },
    ]);

    expect(svc.positionChangeHealth(previous, current)).toBe('REHYDRATION');
  });

  it('allows small ordinary position changes', () => {
    const previous = map([
      { symbol: 'SOL', quantity: 1 },
      { symbol: 'USDC', quantity: 22 },
    ]);
    const current = map([
      { symbol: 'SOL', quantity: 2 },
      { symbol: 'USDC', quantity: 22 },
    ]);

    expect(svc.positionChangeHealth(previous, current)).toBe('OK');
  });
});
