import { TradeSyncProcessor } from './trade-sync.processor';

describe('TradeSyncProcessor', () => {
  it('delivers delayed alert jobs through AlertService', async () => {
    const sync = { syncUser: jest.fn(), listSyncableUserIds: jest.fn() };
    const alerts = { sendTradeAlert: jest.fn().mockResolvedValue(true) };
    const prisma = { auditLog: { create: jest.fn() } };
    const queue = { add: jest.fn() };
    const processor = new TradeSyncProcessor(sync as never, alerts as never, prisma as never, queue as never);

    await expect(processor.process({ name: 'send-alert', data: { tradeEventId: 'trade-1' } } as never)).resolves.toEqual({ sent: true });

    expect(alerts.sendTradeAlert).toHaveBeenCalledWith('trade-1');
    expect(sync.syncUser).not.toHaveBeenCalled();
  });
});
