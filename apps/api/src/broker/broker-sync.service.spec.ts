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
            at: new Date().toISOString(),
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

  it('posts an opted-in Robinhood position delta as a provisional alert', async () => {
    const prisma = {
      syncState: {
        findUnique: jest.fn().mockResolvedValue({
          value: {
            at: new Date().toISOString(),
            positions: [{ symbol: 'AAPL', symbolId: 'sym-aapl', quantity: 1, price: 100, currency: 'USD' }],
          },
        }),
        upsert: jest.fn(),
      },
      tradeEvent: {
        count: jest.fn().mockResolvedValue(0),
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
        broker: { brokerageName?: string },
        ordersComplete: boolean,
      ): Promise<{ created: number; alerted: number }>;
    };

    const result = await svc.syncPositionDeltas('user-1', 'db-account-1', 'provider-account-1', [{ groupId: 'group-1', group: { inferredAlertsEnabled: true } }], [
      { instrument: { id: 'sym-aapl', symbol: 'AAPL' }, units: 2, average_purchase_price: 101, currency: 'USD' },
    ], false, { brokerageName: 'Robinhood' }, true);

    expect(result).toEqual({ created: 1, alerted: 1 });
    expect(prisma.tradeEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ rawStatus: 'INFERRED', rawType: 'position_delta', alertStatus: 'PENDING' }),
    }));
    expect(alerts.sendTradeAlert).toHaveBeenCalledWith('trade-1');
  });

  it('keeps Fidelity position deltas diagnostic-only even when the group opted in', async () => {
    const prisma = {
      syncState: {
        findUnique: jest.fn().mockResolvedValue({ value: { at: new Date().toISOString(), positions: [{ symbol: 'AAPL', symbolId: 'sym-aapl', quantity: 1, price: 100, currency: 'USD' }] } }),
        upsert: jest.fn(),
      },
      tradeEvent: { count: jest.fn().mockResolvedValue(0), upsert: jest.fn().mockResolvedValue({ id: 'trade-1', createdAt: new Date(Date.now() + 60_000), alertStatus: 'SKIPPED' }) },
      auditLog: { create: jest.fn() },
    };
    const alerts = { sendTradeAlert: jest.fn() };
    const svc = new BrokerSyncService(prisma as never, null as never, null as never, new TradeDetectorService(), alerts as never, null as never) as unknown as {
      syncPositionDeltas(userId: string, dbAccountId: string, providerAccountId: string, memberships: { groupId: string; group?: { inferredAlertsEnabled: boolean } }[], positions: unknown[], suppressBackfill: boolean, broker: { brokerageName?: string }, ordersComplete: boolean): Promise<{ created: number; alerted: number }>;
    };

    const result = await svc.syncPositionDeltas('user-1', 'db-account-1', 'provider-account-1', [{ groupId: 'group-1', group: { inferredAlertsEnabled: true } }], [
      { instrument: { id: 'sym-aapl', symbol: 'AAPL' }, units: 2, average_purchase_price: 101, currency: 'USD' },
    ], false, { brokerageName: 'Fidelity' }, true);

    expect(result).toEqual({ created: 1, alerted: 0 });
    expect(alerts.sendTradeAlert).not.toHaveBeenCalled();
  });

  it('does not post a provisional duplicate when a matching confirmed execution exists', async () => {
    const prisma = {
      syncState: {
        findUnique: jest.fn().mockResolvedValue({ value: { at: new Date().toISOString(), positions: [{ symbol: 'AAPL', symbolId: 'sym-aapl', quantity: 1, price: 100, currency: 'USD' }] } }),
        upsert: jest.fn(),
      },
      tradeEvent: {
        count: jest.fn().mockResolvedValue(1),
        upsert: jest.fn().mockResolvedValue({ id: 'trade-1', createdAt: new Date(Date.now() + 60_000), alertStatus: 'SKIPPED' }),
      },
      auditLog: { create: jest.fn() },
    };
    const alerts = { sendTradeAlert: jest.fn() };
    const svc = new BrokerSyncService(prisma as never, null as never, null as never, new TradeDetectorService(), alerts as never, null as never) as unknown as {
      syncPositionDeltas(userId: string, dbAccountId: string, providerAccountId: string, memberships: { groupId: string; group?: { inferredAlertsEnabled: boolean } }[], positions: unknown[], suppressBackfill: boolean, broker: { brokerageName?: string }, ordersComplete: boolean): Promise<{ created: number; alerted: number }>;
    };

    await svc.syncPositionDeltas('user-1', 'db-account-1', 'provider-account-1', [{ groupId: 'group-1', group: { inferredAlertsEnabled: true } }], [
      { instrument: { id: 'sym-aapl', symbol: 'AAPL' }, units: 2, average_purchase_price: 101, currency: 'USD' },
    ], false, { brokerageName: 'Robinhood' }, true);

    expect(prisma.tradeEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ alertStatus: 'SKIPPED' }) }));
    expect(alerts.sendTradeAlert).not.toHaveBeenCalled();
  });

  it('keeps an opted-in Robinhood delta diagnostic-only when its baseline is stale', async () => {
    const prisma = {
      syncState: {
        findUnique: jest.fn().mockResolvedValue({ value: { at: new Date(Date.now() - 60 * 60_000).toISOString(), positions: [{ symbol: 'AAPL', symbolId: 'sym-aapl', quantity: 1, price: 100, currency: 'USD' }] } }),
        upsert: jest.fn(),
      },
      tradeEvent: { count: jest.fn().mockResolvedValue(0), upsert: jest.fn().mockResolvedValue({ id: 'trade-1', createdAt: new Date(Date.now() + 60_000), alertStatus: 'SKIPPED' }) },
      auditLog: { create: jest.fn() },
    };
    const alerts = { sendTradeAlert: jest.fn() };
    const svc = new BrokerSyncService(prisma as never, null as never, null as never, new TradeDetectorService(), alerts as never, null as never) as unknown as {
      syncPositionDeltas(userId: string, dbAccountId: string, providerAccountId: string, memberships: { groupId: string; group?: { inferredAlertsEnabled: boolean } }[], positions: unknown[], suppressBackfill: boolean, broker: { brokerageName?: string }, ordersComplete: boolean): Promise<{ created: number; alerted: number }>;
    };

    await svc.syncPositionDeltas('user-1', 'db-account-1', 'provider-account-1', [{ groupId: 'group-1', group: { inferredAlertsEnabled: true } }], [
      { instrument: { id: 'sym-aapl', symbol: 'AAPL' }, units: 2, average_purchase_price: 101, currency: 'USD' },
    ], false, { brokerageName: 'Robinhood' }, true);

    expect(prisma.tradeEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ alertStatus: 'SKIPPED' }) }));
    expect(alerts.sendTradeAlert).not.toHaveBeenCalled();
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
      fetchOrders(userId: string, userSecret: string, accountId: string): Promise<{ complete: boolean; orders: unknown[] }>;
    };

    await expect(svc.fetchOrders('user-1', 'secret', 'account-1')).resolves.toEqual({ complete: false, orders: [] });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'broker_sync_orders_failed' }),
    }));
  });

  it('processes historical orders when the recent endpoint fails', async () => {
    const historical = [{ brokerage_order_id: 'fidelity-1', status: 'EXECUTED', action: 'BUY' }];
    const prisma = { auditLog: { create: jest.fn() } };
    const snap = {
      listRecentAccountOrders: jest.fn().mockRejectedValue(new Error('recent unavailable')),
      listAccountOrders: jest.fn().mockResolvedValue(historical),
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
      fetchOrders(userId: string, userSecret: string, accountId: string): Promise<{ complete: boolean; orders: unknown[] }>;
    };

    await expect(svc.fetchOrders('user-1', 'secret', 'account-1')).resolves.toEqual({ complete: false, orders: historical });
  });
});
