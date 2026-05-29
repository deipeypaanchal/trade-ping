import { BrokerSyncService } from './broker-sync.service';
import { PositionSnapshotEntry, TradeDetectorService } from './trade-detector.service';

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

  it('records position deltas without sending group alerts', async () => {
    const prisma = {
      syncState: {
        findUnique: jest.fn().mockResolvedValue({
          value: {
            positions: [{ symbol: 'AAPL', symbolId: 'sym-aapl', quantity: 1, price: 100, currency: 'USD' }],
          },
        }),
        upsert: jest.fn(),
      },
      tradeEvent: {
        upsert: jest.fn().mockResolvedValue({ id: 'trade-1', createdAt: new Date(Date.now() + 60_000), alertStatus: 'SKIPPED' }),
      },
      auditLog: { create: jest.fn() },
    };
    const alerts = { sendTradeAlert: jest.fn() };
    const svc = new BrokerSyncService(
      prisma as never,
      null as never,
      null as never,
      new TradeDetectorService(),
      alerts as never,
      null as never,
    ) as unknown as {
      syncPositionDeltas(
        userId: string,
        dbAccountId: string,
        providerAccountId: string,
        memberships: { groupId: string }[],
        positions: unknown[],
        suppressBackfill: boolean,
      ): Promise<{ created: number; alerted: number }>;
    };

    const result = await svc.syncPositionDeltas('user-1', 'db-account-1', 'provider-account-1', [{ groupId: 'group-1' }], [
      { instrument: { id: 'sym-aapl', symbol: 'AAPL' }, units: 2, average_purchase_price: 101, currency: 'USD' },
    ], false);

    expect(result).toEqual({ created: 1, alerted: 0 });
    expect(prisma.tradeEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ rawStatus: 'INFERRED', rawType: 'position_delta', alertStatus: 'SKIPPED' }),
    }));
    expect(alerts.sendTradeAlert).not.toHaveBeenCalled();
  });

  it('sends position deltas when the group opts into inferred alerts', async () => {
    const prisma = {
      syncState: {
        findUnique: jest.fn().mockResolvedValue({
          value: {
            positions: [{ symbol: 'AAPL', symbolId: 'sym-aapl', quantity: 1, price: 100, currency: 'USD' }],
          },
        }),
        upsert: jest.fn(),
      },
      tradeEvent: {
        upsert: jest.fn().mockResolvedValue({ id: 'trade-1', createdAt: new Date(Date.now() + 60_000), alertStatus: 'PENDING' }),
      },
      auditLog: { create: jest.fn() },
    };
    const alerts = { sendTradeAlert: jest.fn().mockResolvedValue(true) };
    const svc = new BrokerSyncService(
      prisma as never,
      null as never,
      null as never,
      new TradeDetectorService(),
      alerts as never,
      null as never,
    ) as unknown as {
      syncPositionDeltas(
        userId: string,
        dbAccountId: string,
        providerAccountId: string,
        memberships: { groupId: string; group?: { inferredAlertsEnabled: boolean } }[],
        positions: unknown[],
        suppressBackfill: boolean,
      ): Promise<{ created: number; alerted: number }>;
    };

    const result = await svc.syncPositionDeltas('user-1', 'db-account-1', 'provider-account-1', [{ groupId: 'group-1', group: { inferredAlertsEnabled: true } }], [
      { instrument: { id: 'sym-aapl', symbol: 'AAPL' }, units: 2, average_purchase_price: 101, currency: 'USD' },
    ], false);

    expect(result).toEqual({ created: 1, alerted: 1 });
    expect(prisma.tradeEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ rawStatus: 'INFERRED', rawType: 'position_delta', alertStatus: 'PENDING' }),
    }));
    expect(alerts.sendTradeAlert).toHaveBeenCalledWith('trade-1');
  });

  it('does not treat failed order fetches as successful syncs', async () => {
    const prisma = { auditLog: { create: jest.fn() } };
    const snap = {
      listRecentAccountOrders: jest.fn().mockRejectedValue(new Error('recent unavailable')),
      listAccountOrders: jest.fn(),
    };
    const config = { getOrThrow: jest.fn().mockReturnValue(3) };
    const svc = new BrokerSyncService(
      prisma as never,
      null as never,
      snap as never,
      null as never,
      null as never,
      config as never,
    ) as unknown as {
      fetchOrders(userId: string, userSecret: string, accountId: string): Promise<{ ok: boolean; orders: unknown[] }>;
    };

    await expect(svc.fetchOrders('user-1', 'secret', 'account-1')).resolves.toEqual({ ok: false, orders: [] });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'broker_sync_orders_failed' }),
    }));
  });
});
