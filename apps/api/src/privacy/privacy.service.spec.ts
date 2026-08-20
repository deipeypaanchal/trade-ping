import { BadRequestException } from '@nestjs/common';
import { PrivacyService } from './privacy.service';

describe('PrivacyService explicit group consent', () => {
  function makeService(existingMembership: {
    alertsEnabled: boolean;
    privacyLevel: string;
    sharingEnabledAt: Date | null;
  } | null = null) {
    const transaction = {
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ deletionPendingAt: null }) },
      group: { update: jest.fn().mockResolvedValue({}) },
      groupMember: {
        findUnique: jest.fn().mockResolvedValue(existingMembership),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      tradeEvent: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
    };
    const prisma = {
      ...transaction,
      $transaction: jest.fn(async (callback: (tx: typeof transaction) => Promise<void>) => callback(transaction)),
    };
    return { service: new PrivacyService(prisma as never), prisma };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(['PUBLIC', 'NORMAL', 'PRIVATE'])('enables %s sharing only for the selected group', async (privacyLevel) => {
    jest.useFakeTimers();
    const consentAt = new Date('2026-08-11T15:00:00.000Z');
    jest.setSystemTime(consentAt);
    const { service, prisma } = makeService();

    await service.setPrivacy('user-1', 'group-a', privacyLevel.toLowerCase());

    const enabled = { privacyLevel, alertsEnabled: true, sharingEnabledAt: consentAt };
    expect(prisma.groupMember.upsert).toHaveBeenCalledWith({
      where: { userId_groupId: { userId: 'user-1', groupId: 'group-a' } },
      update: enabled,
      create: { userId: 'user-1', groupId: 'group-a', ...enabled },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        action: 'privacy_updated',
        metadata: { groupId: 'group-a', level: privacyLevel, sharingEnabledAt: consentAt.toISOString() },
      },
    });
    expect(prisma.tradeEvent.updateMany).not.toHaveBeenCalled();
  });

  it('preserves the consent epoch when changing between enabled privacy levels', async () => {
    jest.useFakeTimers();
    const originalConsentAt = new Date('2026-08-10T12:00:00.000Z');
    jest.setSystemTime(new Date('2026-08-11T15:00:00.000Z'));
    const { service, prisma } = makeService({
      alertsEnabled: true,
      privacyLevel: 'NORMAL',
      sharingEnabledAt: originalConsentAt,
    });

    await service.setPrivacy('user-1', 'group-a', 'public');

    const enabled = { privacyLevel: 'PUBLIC', alertsEnabled: true, sharingEnabledAt: originalConsentAt };
    expect(prisma.groupMember.upsert).toHaveBeenCalledWith({
      where: { userId_groupId: { userId: 'user-1', groupId: 'group-a' } },
      update: enabled,
      create: { userId: 'user-1', groupId: 'group-a', ...enabled },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({ sharingEnabledAt: originalConsentAt.toISOString() }),
      }),
    });
  });

  it('starts a fresh consent epoch when an OFF membership is re-enabled', async () => {
    jest.useFakeTimers();
    const newConsentAt = new Date('2026-08-11T15:00:00.000Z');
    jest.setSystemTime(newConsentAt);
    const { service, prisma } = makeService({
      alertsEnabled: false,
      privacyLevel: 'OFF',
      sharingEnabledAt: null,
    });

    await service.setPrivacy('user-1', 'group-a', 'private');

    expect(prisma.groupMember.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { privacyLevel: 'PRIVATE', alertsEnabled: true, sharingEnabledAt: newConsentAt },
    }));
  });

  it('does not reuse a stale timestamp from an inconsistent disabled row', async () => {
    jest.useFakeTimers();
    const staleTimestamp = new Date('2026-08-10T12:00:00.000Z');
    const newConsentAt = new Date('2026-08-11T15:00:00.000Z');
    jest.setSystemTime(newConsentAt);
    const { service, prisma } = makeService({
      alertsEnabled: false,
      privacyLevel: 'OFF',
      sharingEnabledAt: staleTimestamp,
    });

    await service.setPrivacy('user-1', 'group-a', 'normal');

    expect(prisma.groupMember.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { privacyLevel: 'NORMAL', alertsEnabled: true, sharingEnabledAt: newConsentAt },
    }));
  });

  it('turns sharing off and clears the prior consent timestamp for that group', async () => {
    const { service, prisma } = makeService();

    await service.setPrivacy('user-1', 'group-b', 'off');

    const disabled = { privacyLevel: 'OFF', alertsEnabled: false, sharingEnabledAt: null };
    expect(prisma.groupMember.upsert).toHaveBeenCalledWith({
      where: { userId_groupId: { userId: 'user-1', groupId: 'group-b' } },
      update: disabled,
      create: { userId: 'user-1', groupId: 'group-b', ...disabled },
    });
    expect(prisma.tradeEvent.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', groupId: 'group-b', alertStatus: { in: ['PENDING', 'SENDING'] } },
      data: { alertStatus: 'SKIPPED' },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        action: 'privacy_updated',
        metadata: { groupId: 'group-b', level: 'OFF', sharingEnabledAt: null },
      },
    });
    expect((prisma.groupMember.updateMany as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((prisma.$queryRaw as jest.Mock).mock.invocationCallOrder[0]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect((prisma.$queryRaw as jest.Mock).mock.invocationCallOrder[1])
      .toBeLessThan((prisma.groupMember.upsert as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('remains fail-closed when the fenced final OFF transaction cannot acquire its lock', async () => {
    const { service, prisma } = makeService({
      alertsEnabled: true,
      privacyLevel: 'NORMAL',
      sharingEnabledAt: new Date('2026-08-11T15:00:00.000Z'),
    });
    (prisma.$transaction as jest.Mock)
      .mockImplementationOnce(async (callback: (tx: typeof prisma) => Promise<void>) => callback(prisma))
      .mockRejectedValueOnce(new Error('delivery fence timeout'));

    await expect(service.setPrivacy('user-1', 'group-a', 'off')).rejects.toThrow('delivery fence timeout');

    expect(prisma.groupMember.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', groupId: 'group-a' },
      data: { privacyLevel: 'OFF', alertsEnabled: false, sharingEnabledAt: null },
    });
    expect(prisma.tradeEvent.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', groupId: 'group-a', alertStatus: { in: ['PENDING', 'SENDING'] } },
      data: { alertStatus: 'SKIPPED' },
    });
    expect(prisma.groupMember.upsert).not.toHaveBeenCalled();
  });

  it('rejects invalid privacy levels without creating consent or an audit entry', async () => {
    const { service, prisma } = makeService();

    await expect(service.setPrivacy('user-1', 'group-a', 'friends-only')).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.groupMember.upsert).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not re-enable sharing after account deletion has begun', async () => {
    const { service, prisma } = makeService();
    (prisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue({ deletionPendingAt: new Date() });

    await expect(service.setPrivacy('user-1', 'group-a', 'normal')).rejects.toThrow('Account deletion is pending');

    expect(prisma.groupMember.upsert).not.toHaveBeenCalled();
  });

  it('atomically disables a departed member and cancels their queued group alerts', async () => {
    const { service, prisma } = makeService({
      alertsEnabled: true,
      privacyLevel: 'NORMAL',
      sharingEnabledAt: new Date('2026-08-11T15:00:00.000Z'),
    });

    await service.disableSharing('user-1', 'group-a', 'telegram_group_left');

    expect(prisma.groupMember.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', groupId: 'group-a' },
      data: { privacyLevel: 'OFF', alertsEnabled: false, sharingEnabledAt: null },
    });
    expect(prisma.tradeEvent.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', groupId: 'group-a', alertStatus: { in: ['PENDING', 'SENDING'] } },
      data: { alertStatus: 'SKIPPED' },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        action: 'group_sharing_disabled',
        metadata: { groupId: 'group-a', reason: 'telegram_group_left' },
      },
    });
    expect((prisma.groupMember.updateMany as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((prisma.$queryRaw as jest.Mock).mock.invocationCallOrder[0]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('fails a whole group closed before acquiring its group delivery fence after bot removal', async () => {
    const { service, prisma } = makeService();

    await service.disableGroupSharing('group-a', 'telegram_bot_kicked');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect((prisma.groupMember.updateMany as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((prisma.$queryRaw as jest.Mock).mock.invocationCallOrder[0]);
    expect((prisma.$queryRaw as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((prisma.groupMember.updateMany as jest.Mock).mock.invocationCallOrder[1]);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'group_sharing_disabled',
        metadata: { groupId: 'group-a', reason: 'telegram_bot_kicked' },
      },
    });
  });

  it('turns provisional group alerts off before waiting for the delivery fence', async () => {
    const { service, prisma } = makeService();

    await service.setInferredAlerts('group-a', false);

    expect(prisma.group.update).toHaveBeenCalledTimes(2);
    expect(prisma.group.update).toHaveBeenLastCalledWith({
      where: { id: 'group-a' },
      data: { inferredAlertsEnabled: false },
    });
    expect(prisma.tradeEvent.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.tradeEvent.updateMany).toHaveBeenLastCalledWith({
      where: {
        groupId: 'group-a',
        alertStatus: { in: ['PENDING', 'SENDING'] },
        OR: [{ rawType: 'position_delta' }, { rawStatus: 'INFERRED' }],
      },
      data: { alertStatus: 'SKIPPED' },
    });
    expect((prisma.group.update as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((prisma.$queryRaw as jest.Mock).mock.invocationCallOrder[0]);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'inferred_alerts_updated',
        metadata: { groupId: 'group-a', enabled: false },
      },
    });
  });
});
