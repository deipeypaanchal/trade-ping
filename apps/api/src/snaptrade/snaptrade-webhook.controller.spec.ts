import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Request } from 'express';
import { PrismaService } from '../config/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { SnaptradeService } from './snaptrade.service';
import { SnaptradeWebhookController } from './snaptrade-webhook.controller';

describe('SnaptradeWebhookController', () => {
  const crypto = new CryptoService();
  const config = new ConfigService({ SNAPTRADE_CONSUMER_KEY: 'consumer-secret' });
  const transaction = {
    $queryRaw: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
    idempotencyKey: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    providerDeletion: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findUnique: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    telegramIdentitySuppression: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    groupMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    tradeEvent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    brokerConnection: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    user: { findUnique: jest.fn() },
    providerDeletion: { findUnique: jest.fn() },
    brokerConnection: { findUnique: jest.fn() },
    idempotencyKey: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
  } as unknown as PrismaService;
  const queue = { add: jest.fn().mockResolvedValue({ id: 'job' }) } as unknown as Queue;
  const snap = { deleteConnection: jest.fn().mockResolvedValue(undefined) } as unknown as SnaptradeService;
  const controller = new SnaptradeWebhookController(crypto, config, prisma, queue, snap);

  function signed(
    eventType: string,
    userId = 'snap-user',
    eventTimestamp = new Date().toISOString(),
    extra: Record<string, unknown> = {},
  ) {
    const rawBody = JSON.stringify({ userId, eventTimestamp, eventType, ...extra });
    return {
      rawBody,
      body: JSON.parse(rawBody),
      signature: crypto.hmacBase64('consumer-secret', rawBody),
    };
  }

  const liveUser: {
    id: string;
    snaptradeUserId: string;
    encryptedUserSecret: string;
    brokerSyncEnabled: boolean;
    deletionPendingAt: Date | null;
  } = {
    id: 'app-user',
    snaptradeUserId: 'snap-user',
    encryptedUserSecret: 'encrypted-secret',
    brokerSyncEnabled: true,
    deletionPendingAt: null,
  };

  function mapUser(
    outer: { id: string } = { id: liveUser.id },
    fresh: typeof liveUser | null = liveUser,
  ) {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(outer);
    (transaction.user.findUnique as jest.Mock).mockResolvedValue(fresh);
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    (prisma.idempotencyKey.create as jest.Mock).mockResolvedValue({ key: 'new' });
    (prisma.idempotencyKey.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.idempotencyKey.findUnique as jest.Mock).mockResolvedValue({ status: 'COMPLETED' });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.providerDeletion.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.brokerConnection.findUnique as jest.Mock).mockResolvedValue(null);
    transaction.$queryRaw.mockResolvedValue([{ pg_advisory_xact_lock: null }]);
    transaction.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });
    transaction.user.findUnique.mockResolvedValue(null);
    transaction.providerDeletion.findUnique.mockResolvedValue(null);
    transaction.providerDeletion.findFirst.mockResolvedValue(null);
    transaction.brokerConnection.findUnique.mockResolvedValue(null);
    (queue.add as jest.Mock).mockResolvedValue({ id: 'job' });
    (snap.deleteConnection as jest.Mock).mockResolvedValue(undefined);
  });

  it('verifies the raw signature and queues a freshly mapped, enabled user inside both lifecycle fences', async () => {
    const event = signed('ACCOUNT_HOLDINGS_UPDATED');
    mapUser();

    await expect(controller.webhook(
      event.body,
      event.signature,
      { rawBody: event.rawBody } as Request & { rawBody?: string },
    )).resolves.toEqual({ ok: true });

    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      'sync-user',
      { userId: 'app-user' },
      expect.objectContaining({ jobId: expect.stringMatching(/^sync-user:app-user:[a-f0-9]{16}$/) }),
    );
    expect(transaction.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'app-user' }),
    }));
    expect(transaction.idempotencyKey.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'COMPLETED', completedAt: expect.any(Date) }),
    }));
  });

  it('rechecks the durable broker-sync switch behind the fence before queueing', async () => {
    const event = signed('ACCOUNT_HOLDINGS_UPDATED');
    mapUser({ id: 'app-user' }, { ...liveUser, brokerSyncEnabled: false });

    await controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never);

    expect(queue.add).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).toHaveBeenCalled();
  });

  it('does not queue or retain an audit when account deletion became pending before the fence', async () => {
    const event = signed('ACCOUNT_HOLDINGS_UPDATED');
    mapUser({ id: 'app-user' }, { ...liveUser, deletionPendingAt: new Date() });

    await controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never);

    expect(queue.add).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it('ignores an old-generation event when the provider mapping changed while it waited for the fence', async () => {
    const event = signed('ACCOUNT_HOLDINGS_UPDATED');
    mapUser({ id: 'app-user' }, { ...liveUser, snaptradeUserId: 'snap-replacement' });

    await controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never);

    expect(queue.add).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it('accepts a signed provider retry delayed by thirty minutes', async () => {
    const event = signed(
      'ACCOUNT_HOLDINGS_UPDATED',
      'snap-user',
      new Date(Date.now() - 30 * 60_000).toISOString(),
    );
    await expect(controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never))
      .resolves.toEqual({ ok: true });
  });

  it('rejects events outside the signed timestamp horizon', async () => {
    const old = signed(
      'ACCOUNT_HOLDINGS_UPDATED',
      'snap-user',
      new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
    );
    const future = signed(
      'ACCOUNT_HOLDINGS_UPDATED',
      'snap-user',
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    await expect(controller.webhook(old.body, old.signature, { rawBody: old.rawBody } as never))
      .rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.webhook(future.body, future.signature, { rawBody: future.rawBody } as never))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('acks a canonical duplicate only after the durable row is completed', async () => {
    const event = signed('ACCOUNT_HOLDINGS_UPDATED');
    (prisma.idempotencyKey.create as jest.Mock)
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));

    await expect(controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never))
      .resolves.toEqual({ ok: true, replay: true });

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('returns retryable failure for a duplicate whose processing lease is still active', async () => {
    const event = signed('ACCOUNT_HOLDINGS_UPDATED');
    (prisma.idempotencyKey.create as jest.Mock)
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    (prisma.idempotencyKey.findUnique as jest.Mock).mockResolvedValue({ status: 'PROCESSING' });

    await expect(controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('atomically reclaims an expired processing lease after a crashed handler', async () => {
    const event = signed('ACCOUNT_HOLDINGS_UPDATED');
    (prisma.idempotencyKey.create as jest.Mock)
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    (prisma.idempotencyKey.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

    await expect(controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never))
      .resolves.toEqual({ ok: true });

    expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'PROCESSING', leaseUntil: { lte: expect.any(Date) } }),
      data: expect.objectContaining({ processingToken: expect.any(String) }),
    }));
  });

  it('expires its token-owned lease immediately when downstream work fails', async () => {
    const event = signed('ACCOUNT_HOLDINGS_UPDATED');
    mapUser();
    transaction.auditLog.create.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never))
      .rejects.toThrow('database unavailable');

    expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledWith({
      where: {
        key: expect.stringMatching(/^snaptrade:/),
        status: 'PROCESSING',
        processingToken: expect.any(String),
      },
      data: { leaseUntil: new Date(0) },
    });
  });

  it('confirms account deletion and marks the Telegram identity boundary completed in the same transaction', async () => {
    const event = signed('USER_DELETED', 'snap-account-delete');
    const deletion = {
      localUserId: 'minimal-user',
      purpose: 'ACCOUNT_DELETION',
      status: 'PENDING',
    };
    (prisma.providerDeletion.findUnique as jest.Mock).mockResolvedValue(deletion);
    transaction.providerDeletion.findUnique.mockResolvedValue(deletion);
    transaction.user.findUnique.mockResolvedValue(null);

    await expect(controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never))
      .resolves.toEqual({ ok: true });

    expect(transaction.user.deleteMany).toHaveBeenCalledWith({ where: { id: 'minimal-user' } });
    expect(transaction.telegramIdentitySuppression.updateMany).toHaveBeenCalledWith({
      where: { localUserId: 'minimal-user', deletionCompletedAt: null },
      data: { deletionCompletedAt: expect.any(Date), localUserId: null },
    });
    expect(transaction.providerDeletion.deleteMany).toHaveBeenCalledWith({
      where: { provider: 'snaptrade', providerUserId: 'snap-account-delete' },
    });
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it('confirms an old-generation replacement tombstone without deleting the replacement user', async () => {
    const event = signed('USER_DELETED', 'snap-old');
    const deletion = { localUserId: 'live-user', purpose: 'SECRET_REPLACEMENT', status: 'PENDING' };
    (prisma.providerDeletion.findUnique as jest.Mock).mockResolvedValue(deletion);
    transaction.providerDeletion.findUnique.mockResolvedValue(deletion);

    await controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never);

    expect(transaction.providerDeletion.updateMany).toHaveBeenCalled();
    expect(transaction.providerDeletion.deleteMany).toHaveBeenCalled();
    expect(transaction.user.deleteMany).not.toHaveBeenCalled();
  });

  it('fails closed inside the lifecycle transaction for current-generation provider deletion', async () => {
    const event = signed('USER_DELETED');
    mapUser();

    await controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never);

    expect(transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'app-user', snaptradeUserId: 'snap-user' },
      data: { snaptradeUserId: null, encryptedUserSecret: null, brokerSyncEnabled: false },
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it('fails all sharing closed for CONNECTION_DELETED even when the authorization row is absent', async () => {
    const event = signed('CONNECTION_DELETED', 'snap-user', new Date().toISOString(), {
      brokerageAuthorizationId: 'auth-deleted',
    });
    mapUser();
    transaction.brokerConnection.findUnique.mockResolvedValue(null);

    await controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never);

    expect(transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'app-user' },
      data: { brokerSyncEnabled: false },
    });
    expect(transaction.groupMember.updateMany).toHaveBeenCalledWith({
      where: { userId: 'app-user' },
      data: { privacyLevel: 'OFF', alertsEnabled: false, sharingEnabledAt: null },
    });
    expect(transaction.tradeEvent.updateMany).toHaveBeenCalledWith({
      where: { userId: 'app-user', alertStatus: { in: ['PENDING', 'SENDING'] } },
      data: { alertStatus: 'SKIPPED' },
    });
  });

  it('actively revokes CONNECTION_ADDED when the fresh gate is disabled, even without a local authorization row', async () => {
    const event = signed('CONNECTION_ADDED', 'snap-user', new Date().toISOString(), {
      brokerageAuthorizationId: 'auth-unexpected',
    });
    mapUser({ id: 'app-user' }, { ...liveUser, brokerSyncEnabled: false });
    jest.spyOn(crypto, 'decrypt').mockReturnValue('plain-secret');
    transaction.brokerConnection.findUnique.mockResolvedValue(null);

    await controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never);

    expect(snap.deleteConnection).toHaveBeenCalledWith('snap-user', 'plain-secret', 'auth-unexpected');
    expect(transaction.brokerConnection.updateMany).toHaveBeenCalledWith({
      where: { authorizationId: 'auth-unexpected', userId: 'app-user' },
      data: {
        status: 'DISCONNECTED',
        disabledReason: 'Authorization revoked because broker sync was disabled',
        disconnectedAt: expect.any(Date),
      },
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('leaves CONNECTION_ADDED reclaimable when remote revocation fails', async () => {
    const event = signed('CONNECTION_ADDED', 'snap-user', new Date().toISOString(), {
      brokerageAuthorizationId: 'auth-unexpected',
    });
    mapUser({ id: 'app-user' }, { ...liveUser, brokerSyncEnabled: false });
    jest.spyOn(crypto, 'decrypt').mockReturnValue('plain-secret');
    (snap.deleteConnection as jest.Mock).mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never))
      .rejects.toThrow('provider unavailable');

    expect(transaction.brokerConnection.updateMany).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { leaseUntil: new Date(0) },
    }));
  });

  it('treats provider 404 as a successful replay of an already-finished authorization revoke', async () => {
    const event = signed('CONNECTION_ADDED', 'snap-user', new Date().toISOString(), {
      brokerageAuthorizationId: 'auth-unexpected',
    });
    mapUser({ id: 'app-user' }, { ...liveUser, brokerSyncEnabled: false });
    jest.spyOn(crypto, 'decrypt').mockReturnValue('plain-secret');
    (snap.deleteConnection as jest.Mock)
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { status: 404 }));

    await expect(controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never))
      .resolves.toEqual({ ok: true });

    expect(transaction.brokerConnection.updateMany).toHaveBeenCalled();
  });

  it('an unknown old provider id cannot mutate, queue, or audit against a replacement local user', async () => {
    const event = signed('USER_DELETED', 'snap-unknown-old');

    await controller.webhook(event.body, event.signature, { rawBody: event.rawBody } as never);

    expect(transaction.$queryRaw).not.toHaveBeenCalled();
    expect(transaction.user.updateMany).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });
});
