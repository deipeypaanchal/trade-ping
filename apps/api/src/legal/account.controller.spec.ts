import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountController } from './account.controller';
import { PrismaService } from '../config/prisma.service';
import { BrokerOnboardingService, RemoteUserDeletionResult } from '../broker/broker-onboarding.service';

const SECRET = 'a'.repeat(32);

function makeController(result: RemoteUserDeletionResult = {
  state: 'PENDING',
  providerDeletionRequired: true,
  providerCredentialState: 'COMPLETE',
  purgedJobs: 2,
}) {
  const prisma = {
    user: { findUnique: jest.fn(), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
  } as unknown as PrismaService;
  const broker = { deleteRemoteUser: jest.fn().mockResolvedValue(result) } as unknown as BrokerOnboardingService;
  return {
    controller: new AccountController(prisma, broker, new ConfigService({ INTERNAL_JOB_SECRET: SECRET })),
    prisma,
    broker,
  };
}

describe('AccountController DELETE /account/delete', () => {
  it('rejects requests missing auth or an exact identifier', async () => {
    const { controller } = makeController();
    await expect(controller.deleteAccount({ userId: 'x' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.deleteAccount({}, `Bearer ${SECRET}`)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.deleteAccount({ userId: 'x', telegramUserId: 'y' }, `Bearer ${SECRET}`)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns pending and retains the minimal user until provider confirmation', async () => {
    const { controller, prisma, broker } = makeController();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'alice' });

    await expect(controller.deleteAccount({ userId: 'alice' }, `Bearer ${SECRET}`)).resolves.toEqual({
      ok: true,
      deleted: false,
      pending: true,
      deletionRequestId: 'alice',
      remoteDeletionAccepted: true,
      retryRequired: false,
      manualReviewRequired: false,
      providerDeletionRequired: true,
      providerCredentialState: 'COMPLETE',
      purgedJobs: 2,
    });
    expect(broker.deleteRemoteUser).toHaveBeenCalledWith('alice');
    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
  });

  it('reports a retryable provider failure without claiming deletion', async () => {
    const { controller, prisma } = makeController({
      state: 'RETRY_REQUIRED',
      providerDeletionRequired: true,
      providerCredentialState: 'PROVIDER_ID_ONLY',
      purgedJobs: 0,
    });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'alice' });

    await expect(controller.deleteAccount({ userId: 'alice' }, `Bearer ${SECRET}`)).resolves.toEqual(expect.objectContaining({
      deleted: false,
      pending: true,
      remoteDeletionAccepted: false,
      retryRequired: true,
      manualReviewRequired: false,
    }));
  });

  it('returns an opaque request id that can be used after telegramUserId is scrubbed', async () => {
    const { controller, prisma, broker } = makeController();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'opaque-local-id' });

    const first = await controller.deleteAccount({ telegramUserId: '12345' }, `Bearer ${SECRET}`);
    const retry = await controller.deleteAccount({ userId: first.deletionRequestId }, `Bearer ${SECRET}`);

    expect(first).toEqual(expect.objectContaining({ pending: true, deletionRequestId: 'opaque-local-id' }));
    expect(retry).toEqual(expect.objectContaining({ pending: true, deletionRequestId: 'opaque-local-id' }));
    expect(broker.deleteRemoteUser).toHaveBeenNthCalledWith(2, 'opaque-local-id');
  });

  it('deletes immediately only when no provider identity exists', async () => {
    const { controller, prisma } = makeController({
      state: 'COMPLETE',
      providerDeletionRequired: false,
      providerCredentialState: 'NONE',
      purgedJobs: 0,
    });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'alice' });

    await expect(controller.deleteAccount({ userId: 'alice' }, `Bearer ${SECRET}`)).resolves.toEqual({
      ok: true,
      deleted: true,
      pending: false,
      providerDeletionRequired: false,
      providerCredentialState: 'NONE',
      purgedJobs: 0,
    });
    expect(prisma.user.deleteMany).toHaveBeenCalledWith({ where: { id: 'alice' } });
  });

  it('returns deleted:false idempotently when the user does not exist', async () => {
    const { controller, prisma, broker } = makeController();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(controller.deleteAccount({ telegramUserId: '12345' }, `Bearer ${SECRET}`)).resolves.toEqual({
      ok: true,
      deleted: false,
      pending: false,
      notFound: true,
    });
    expect(broker.deleteRemoteUser).not.toHaveBeenCalled();
  });
});
