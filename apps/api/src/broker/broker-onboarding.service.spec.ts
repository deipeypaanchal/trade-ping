import { BadRequestException } from '@nestjs/common';
import { BrokerOnboardingService } from './broker-onboarding.service';
import { EncryptedSecretError } from '../security/errors';

describe('BrokerOnboardingService', () => {
  const user = {
    id: 'user-1',
    telegramUserId: 'tg-1',
    displayName: 'Alice',
    timeZone: 'UTC',
    snaptradeUserId: 'snap-user-1',
    encryptedUserSecret: 'encrypted',
    snaptradeGeneration: 2,
    brokerSyncEnabled: true,
    deletionPendingAt: null,
    deletionBlockReason: null,
    updatedAt: new Date('2026-08-10T00:00:00.000Z'),
  };

  function harness(overrides: {
    user?: Record<string, unknown>;
    connections?: Array<Record<string, unknown>>;
    snap?: Record<string, jest.Mock>;
    crypto?: Record<string, jest.Mock>;
    tombstone?: Record<string, unknown> | null;
    queue?: { getJobs: jest.Mock };
  } = {}) {
    const currentUser = { ...user, ...overrides.user };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
      user: {
        findUnique: jest.fn().mockResolvedValue(currentUser),
        findUniqueOrThrow: jest.fn().mockResolvedValue(currentUser),
        update: jest.fn().mockResolvedValue(currentUser),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      groupMember: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      tradeEvent: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      syncState: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      brokerConnection: {
        findMany: jest.fn().mockResolvedValue(overrides.connections ?? []),
        upsert: jest.fn().mockResolvedValue({ id: 'connection-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      brokerAccount: { upsert: jest.fn().mockResolvedValue({}) },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      providerDeletion: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      telegramIdentitySuppression: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(currentUser),
        findUnique: jest.fn().mockResolvedValue(currentUser),
        update: jest.fn().mockResolvedValue(currentUser),
      },
      groupMember: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      tradeEvent: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ id: 'trade-1' }]),
      },
      brokerConnection: {
        findMany: jest.fn().mockResolvedValue(overrides.connections ?? []),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      providerDeletion: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(overrides.tombstone ?? null),
        findUnique: jest.fn().mockResolvedValue(overrides.tombstone ?? null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const snap = {
      connectionPortal: jest.fn().mockResolvedValue({ redirectURI: 'https://snaptrade.example/connect', sessionId: 'session-1' }),
      registerUser: jest.fn(),
      deleteUser: jest.fn().mockResolvedValue(undefined),
      listConnections: jest.fn().mockResolvedValue([]),
      deleteConnection: jest.fn().mockResolvedValue(undefined),
      ...overrides.snap,
    };
    const crypto = {
      decrypt: jest.fn().mockReturnValue('secret'),
      encrypt: jest.fn().mockReturnValue('encrypted-replacement'),
      hash: jest.fn().mockReturnValue('telegram-identity-hash'),
      ...overrides.crypto,
    };
    return {
      svc: new BrokerOnboardingService(prisma as never, snap as never, crypto as never, overrides.queue as never),
      prisma,
      snap,
      crypto,
      tx,
    };
  }

  it('creates a fail-closed pending membership when opening a connect portal', async () => {
    const { svc, tx, snap } = harness();

    await expect(svc.createConnectUrl('user-1', 'group-b')).resolves.toBe('https://snaptrade.example/connect');

    expect(snap.connectionPortal).toHaveBeenCalledWith('snap-user-1', 'secret', 'group-b');
    expect(tx.groupMember.upsert).toHaveBeenCalledWith({
      where: { userId_groupId: { userId: 'user-1', groupId: 'group-b' } },
      update: {},
      create: { userId: 'user-1', groupId: 'group-b', privacyLevel: 'OFF', alertsEnabled: false, sharingEnabledAt: null },
    });
  });

  it('opens reconnect mode for exactly one matching disabled authorization', async () => {
    const { svc, snap } = harness({
      connections: [
        { authorizationId: 'auth-1', brokerageName: 'Robinhood', brokerageSlug: 'ROBINHOOD', status: 'DISABLED', updatedAt: new Date() },
        { authorizationId: 'auth-2', brokerageName: 'Fidelity', brokerageSlug: 'FIDELITY', status: 'ERROR', updatedAt: new Date() },
      ],
    });

    await svc.createReconnectUrl('user-1', 'group-1', 'fidelity');
    expect(snap.connectionPortal).toHaveBeenCalledWith('snap-user-1', 'secret', 'group-1', 'auth-2');
  });

  it('requires a brokerage name when multiple connections need repair', async () => {
    const { svc } = harness({
      connections: [
        { authorizationId: 'auth-1', brokerageName: 'Robinhood', status: 'DISABLED', updatedAt: new Date() },
        { authorizationId: 'auth-2', brokerageName: 'Fidelity', status: 'ERROR', updatedAt: new Date() },
      ],
    });
    await expect(svc.createReconnectUrl('user-1', 'group-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps a unique replacement and tombstone before requesting old-user deletion', async () => {
    const registerUser = jest.fn(async (providerUserId: string) => ({ userId: providerUserId, userSecret: 'replacement-secret' }));
    const { svc, snap, prisma, tx } = harness({
      snap: { registerUser },
      crypto: { decrypt: jest.fn(() => { throw new EncryptedSecretError('bad key'); }) },
    });

    await expect(svc.createConnectUrl('user-1', 'group-1')).resolves.toBe('https://snaptrade.example/connect');

    expect(snap.registerUser).toHaveBeenCalledWith(expect.stringMatching(/^user-1-g-3-[0-9a-f]{16}$/));
    expect(prisma.providerDeletion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ providerUserId: expect.stringMatching(/^user-1-g-3-[0-9a-f]{16}$/), status: 'REGISTRATION', generation: 3 }),
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        snaptradeUserId: expect.stringMatching(/^user-1-g-3-[0-9a-f]{16}$/),
        encryptedUserSecret: 'encrypted-replacement',
        snaptradeGeneration: 3,
        brokerSyncEnabled: true,
      },
    });
    expect(tx.providerDeletion.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { provider_providerUserId: { provider: 'snaptrade', providerUserId: 'snap-user-1' } },
      create: expect.objectContaining({ purpose: 'SECRET_REPLACEMENT', generation: 2, status: 'READY' }),
    }));
    expect(tx.providerDeletion.upsert.mock.invocationCallOrder[0]).toBeLessThan(snap.deleteUser.mock.invocationCallOrder[0]);
    expect(snap.deleteUser).toHaveBeenCalledWith('snap-user-1');
    expect(prisma.providerDeletion.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PENDING' }),
    }));
    expect(snap.connectionPortal).toHaveBeenCalledWith(expect.stringMatching(/^user-1-g-3-[0-9a-f]{16}$/), 'replacement-secret', 'group-1');
  });

  it('persists and requests cleanup of a newly registered provider user when local replacement mapping fails', async () => {
    const registerUser = jest.fn(async (providerUserId: string) => ({ userId: providerUserId, userSecret: 'replacement-secret' }));
    const { svc, snap, prisma, tx } = harness({
      snap: { registerUser },
      crypto: { decrypt: jest.fn(() => { throw new EncryptedSecretError('bad key'); }) },
    });
    tx.user.update.mockRejectedValueOnce(new Error('mapping transaction failed'));

    await expect(svc.createConnectUrl('user-1', 'group-1')).rejects.toThrow('mapping transaction failed');

    expect(prisma.providerDeletion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ providerUserId: expect.stringMatching(/^user-1-g-3-[0-9a-f]{16}$/), status: 'REGISTRATION' }),
    });
    expect(prisma.providerDeletion.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: 'READY' }),
    }));
    expect(snap.deleteUser).toHaveBeenCalledWith(expect.stringMatching(/^user-1-g-3-[0-9a-f]{16}$/));
  });

  it('blocks portal creation once durable account deletion is pending', async () => {
    const { svc, snap } = harness({ user: { deletionPendingAt: new Date() } });
    await expect(svc.createConnectUrl('user-1', 'group-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(snap.connectionPortal).not.toHaveBeenCalled();
  });

  it('fails closed behind sync and delivery fences before remote disconnect', async () => {
    const { svc, prisma, tx, snap } = harness({
      snap: {
        listConnections: jest.fn().mockResolvedValue([{ id: 'auth-1' }, { id: 'auth-2' }]),
        deleteConnection: jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('provider unavailable')),
      },
    });

    await expect(svc.disconnectAll('user-1')).resolves.toEqual({ revoked: 1, failed: 1, remoteRevocationComplete: false });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { brokerSyncEnabled: false, deletionPendingAt: undefined },
    });
    // Two lifecycle fences plus the guarded post-disconnect audit all use the
    // same cross-process user lock.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.user.update.mock.invocationCallOrder[0]).toBeLessThan(snap.listConnections.mock.invocationCallOrder[0]);
  });

  it('reports partial credentials as incomplete during disconnect', async () => {
    const { svc, snap } = harness({ user: { encryptedUserSecret: null } });
    await expect(svc.disconnectAll('user-1')).resolves.toEqual({ revoked: 0, failed: 0, remoteRevocationComplete: false });
    expect(snap.listConnections).not.toHaveBeenCalled();
  });

  it('revokes the provider generation observed after the disconnect fence drains', async () => {
    const { svc, prisma, snap } = harness({
      snap: { listConnections: jest.fn().mockResolvedValue([{ id: 'auth-new' }]) },
    });
    (prisma.user.findUniqueOrThrow as jest.Mock)
      .mockResolvedValueOnce({
        ...user,
        snaptradeUserId: 'snap-new-generation',
        encryptedUserSecret: 'encrypted-new-generation',
        snaptradeGeneration: 3,
        brokerSyncEnabled: false,
      });

    await expect(svc.disconnectAll('user-1')).resolves.toEqual({
      revoked: 1,
      failed: 0,
      remoteRevocationComplete: true,
    });

    expect(snap.listConnections).toHaveBeenCalledWith('snap-new-generation', 'secret');
    expect(snap.deleteConnection).toHaveBeenCalledWith('snap-new-generation', 'secret', 'auth-new');
    expect(snap.listConnections).not.toHaveBeenCalledWith('snap-user-1', expect.anything());
  });

  it('scrubs local content, then returns pending only after provider acceptance', async () => {
    const { svc, tx, snap, prisma } = harness();

    await expect(svc.deleteRemoteUser('user-1')).resolves.toEqual({
      state: 'PENDING',
      providerDeletionRequired: true,
      providerCredentialState: 'COMPLETE',
      purgedJobs: 0,
    });

    expect(tx.providerDeletion.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        providerUserId: 'snap-user-1',
        purpose: 'ACCOUNT_DELETION',
        generation: 2,
        status: 'READY',
      }),
    }));
    expect(tx.telegramIdentitySuppression.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { identityHash: 'telegram-identity-hash' },
      create: expect.objectContaining({ identityHash: 'telegram-identity-hash' }),
    }));
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ telegramUserId: null, snaptradeUserId: null, encryptedUserSecret: null, brokerSyncEnabled: false }),
    }));
    expect(tx.providerDeletion.upsert.mock.invocationCallOrder[0]).toBeLessThan(snap.deleteUser.mock.invocationCallOrder[0]);
    expect(prisma.providerDeletion.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PENDING' }),
    }));
  });

  it('re-reads the provider generation after draining an in-flight portal before deletion', async () => {
    const { svc, prisma, tx, snap } = harness();
    const replacement = {
      ...user,
      snaptradeUserId: 'snap-user-new-generation',
      encryptedUserSecret: 'encrypted-new-generation',
      snaptradeGeneration: 3,
      deletionPendingAt: new Date('2026-08-11T00:00:00.000Z'),
      brokerSyncEnabled: false,
    };
    (prisma.user.findUniqueOrThrow as jest.Mock)
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce(replacement);

    await expect(svc.deleteRemoteUser('user-1')).resolves.toEqual(expect.objectContaining({
      state: 'PENDING',
      providerCredentialState: 'COMPLETE',
    }));

    expect(tx.providerDeletion.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        provider_providerUserId: {
          provider: 'snaptrade',
          providerUserId: 'snap-user-new-generation',
        },
      },
      create: expect.objectContaining({
        providerUserId: 'snap-user-new-generation',
        generation: 3,
      }),
    }));
    expect(snap.deleteUser).toHaveBeenCalledWith('snap-user-new-generation');
    expect(snap.deleteUser).not.toHaveBeenCalledWith('snap-user-1');
  });

  it('purges queued sync and alert jobs during account deletion', async () => {
    const userJob = { data: { userId: 'user-1' }, remove: jest.fn().mockResolvedValue(undefined) };
    const alertJob = { data: { tradeEventId: 'trade-1' }, remove: jest.fn().mockResolvedValue(undefined) };
    const otherJob = { data: { userId: 'other' }, remove: jest.fn() };
    const queue = { getJobs: jest.fn().mockResolvedValue([userJob, alertJob, otherJob]) };
    const { svc } = harness({ queue });

    await expect(svc.deleteRemoteUser('user-1')).resolves.toEqual(expect.objectContaining({ purgedJobs: 2 }));
    expect(queue.getJobs).toHaveBeenCalledWith(expect.arrayContaining(['active', 'delayed', 'completed']), 0, -1, true);
    expect(userJob.remove).toHaveBeenCalled();
    expect(alertJob.remove).toHaveBeenCalled();
    expect(otherJob.remove).not.toHaveBeenCalled();
  });

  it('retains a READY retry handle and reports provider rejection truthfully', async () => {
    const { svc, prisma } = harness({ snap: { deleteUser: jest.fn().mockRejectedValue(new Error('provider unavailable')) } });

    await expect(svc.deleteRemoteUser('user-1')).resolves.toEqual(expect.objectContaining({
      state: 'RETRY_REQUIRED',
      providerDeletionRequired: true,
    }));
    expect(prisma.providerDeletion.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'READY', lastError: 'provider unavailable' }),
    }));
  });

  it('treats an authoritative provider 404 as terminal for the exact deletion tombstone', async () => {
    const tombstone = {
      provider: 'snaptrade',
      providerUserId: 'snap-user-1',
      localUserId: 'user-1',
      purpose: 'ACCOUNT_DELETION',
      generation: 2,
      status: 'READY',
    };
    const missing = Object.assign(new Error('provider user missing'), { status: 404 });
    const { svc, tx } = harness({ tombstone, snap: { deleteUser: jest.fn().mockRejectedValue(missing) } });

    await expect(svc.deleteRemoteUser('user-1')).resolves.toEqual(expect.objectContaining({
      state: 'COMPLETE',
      providerDeletionRequired: false,
    }));
    expect(tx.user.deleteMany).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(tx.providerDeletion.deleteMany).toHaveBeenCalledWith({
      where: { provider: 'snaptrade', providerUserId: 'snap-user-1' },
    });
  });

  it('requires manual review for a secret-only partial provider identity', async () => {
    const { svc, tx, snap } = harness({ user: { snaptradeUserId: null, encryptedUserSecret: 'orphaned-secret' } });

    await expect(svc.deleteRemoteUser('user-1')).resolves.toEqual(expect.objectContaining({
      state: 'MANUAL_REVIEW_REQUIRED',
      providerCredentialState: 'SECRET_ONLY',
    }));
    expect(snap.deleteUser).not.toHaveBeenCalled();
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ telegramUserId: null, encryptedUserSecret: null }),
    }));
  });

  it('completes locally when no provider identity exists', async () => {
    const { svc, snap } = harness({ user: { snaptradeUserId: null, encryptedUserSecret: null } });
    await expect(svc.deleteRemoteUser('user-1')).resolves.toEqual(expect.objectContaining({
      state: 'COMPLETE',
      providerDeletionRequired: false,
      providerCredentialState: 'NONE',
    }));
    expect(snap.deleteUser).not.toHaveBeenCalled();
  });

  it('retries READY and stale PENDING deletion handles independently of Telegram identity', async () => {
    const { svc, prisma, snap } = harness();
    (prisma.providerDeletion.findMany as jest.Mock).mockResolvedValue([
      { providerUserId: 'snap-ready' },
      { providerUserId: 'snap-stale' },
    ]);

    await expect(svc.retryProviderDeletions()).resolves.toEqual({ attempted: 2, accepted: 2 });
    expect(snap.deleteUser).toHaveBeenCalledWith('snap-ready');
    expect(snap.deleteUser).toHaveBeenCalledWith('snap-stale');
  });
});
