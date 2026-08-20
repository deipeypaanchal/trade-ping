import { TradeSyncProcessor } from './trade-sync.processor';

describe('TradeSyncProcessor', () => {
  function harness() {
    const sync = { syncUser: jest.fn().mockResolvedValue({ created: 0, alerted: 0 }), listSyncableUserIds: jest.fn().mockResolvedValue([]) };
    const alerts = { sendTradeAlert: jest.fn().mockResolvedValue(true) };
    const prisma = {
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      tradeEvent: { findUnique: jest.fn().mockResolvedValue({ userId: 'user-1' }) },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1', deletionPendingAt: null }) },
      providerDeletion: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const queue = { add: jest.fn() };
    const processor = new TradeSyncProcessor(sync as never, alerts as never, prisma as never, queue as never);
    return { processor, sync, alerts, prisma, queue };
  }

  it('delivers a normal delayed alert job', async () => {
    const { processor, alerts } = harness();
    const job = { name: 'send-alert', data: { tradeEventId: 'trade-1' }, updateData: jest.fn() };

    await expect(processor.process(job as never)).resolves.toEqual({ sent: true });

    expect(alerts.sendTradeAlert).toHaveBeenCalledWith('trade-1');
    expect(job.updateData).not.toHaveBeenCalled();
  });

  it('scrubs and skips a queued job for a pending account deletion', async () => {
    const { processor, sync, prisma } = harness();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'user-1', deletionPendingAt: new Date() });
    const job = { name: 'sync-user', data: { userId: 'user-1' }, updateData: jest.fn().mockImplementation(async (data) => { job.data = data; }) };

    await expect(processor.process(job as never)).resolves.toEqual({ skipped: 'account-deletion' });

    expect(sync.syncUser).not.toHaveBeenCalled();
    expect(job.updateData).toHaveBeenCalledWith({ lifecycleScrubbed: true });
  });

  it('rechecks and scrubs job data when deletion starts during active work', async () => {
    const { processor, prisma } = harness();
    (prisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'user-1', deletionPendingAt: null })
      .mockResolvedValueOnce({ id: 'user-1', deletionPendingAt: new Date() });
    const job = { name: 'sync-user', data: { userId: 'user-1' }, updateData: jest.fn().mockImplementation(async (data) => { job.data = data; }) };

    await processor.process(job as never);

    expect(job.updateData).toHaveBeenCalledWith({ lifecycleScrubbed: true });
  });

  it('does not write a post-deletion failure audit for scrubbed job data', async () => {
    const { processor, prisma } = harness();
    await processor.onFailed({
      id: 'job-1',
      name: 'sync-user',
      data: { lifecycleScrubbed: true },
      attemptsMade: 3,
    } as never, new Error('stopped'));
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
