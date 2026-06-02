import { BadRequestException } from '@nestjs/common';
import { BrokerOnboardingService } from './broker-onboarding.service';

describe('BrokerOnboardingService reconnect flow', () => {
  const user = { id: 'user-1', snaptradeUserId: 'snap-user-1', encryptedUserSecret: 'encrypted' };

  function makeService(connections: Array<{ authorizationId: string; brokerageName: string; brokerageSlug: string; status: 'DISABLED' | 'ERROR'; updatedAt: Date }>) {
    const prisma = {
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue(user) },
      brokerConnection: { findMany: jest.fn().mockResolvedValue(connections) },
      auditLog: { create: jest.fn() },
    };
    const snap = { connectionPortal: jest.fn().mockResolvedValue({ redirectURI: 'https://snaptrade.example/reconnect', sessionId: 'session-1' }) };
    const crypto = { decrypt: jest.fn().mockReturnValue('secret') };
    return { svc: new BrokerOnboardingService(prisma as never, snap as never, crypto as never), snap, prisma };
  }

  it('opens SnapTrade reconnect mode for the existing disabled authorization', async () => {
    const { svc, snap } = makeService([{ authorizationId: 'auth-1', brokerageName: 'Robinhood', brokerageSlug: 'ROBINHOOD', status: 'DISABLED', updatedAt: new Date() }]);

    await expect(svc.createReconnectUrl('user-1', 'group-1')).resolves.toBe('https://snaptrade.example/reconnect');
    expect(snap.connectionPortal).toHaveBeenCalledWith('snap-user-1', 'secret', 'group-1', 'auth-1');
  });

  it('requires a brokerage name when multiple connections need repair', async () => {
    const { svc } = makeService([
      { authorizationId: 'auth-1', brokerageName: 'Robinhood', brokerageSlug: 'ROBINHOOD', status: 'DISABLED', updatedAt: new Date() },
      { authorizationId: 'auth-2', brokerageName: 'Fidelity', brokerageSlug: 'FIDELITY', status: 'ERROR', updatedAt: new Date() },
    ]);

    await expect(svc.createReconnectUrl('user-1', 'group-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('selects the requested brokerage when multiple connections need repair', async () => {
    const { svc, snap } = makeService([
      { authorizationId: 'auth-1', brokerageName: 'Robinhood', brokerageSlug: 'ROBINHOOD', status: 'DISABLED', updatedAt: new Date() },
      { authorizationId: 'auth-2', brokerageName: 'Fidelity', brokerageSlug: 'FIDELITY', status: 'ERROR', updatedAt: new Date() },
    ]);

    await svc.createReconnectUrl('user-1', 'group-1', 'fidelity');
    expect(snap.connectionPortal).toHaveBeenCalledWith('snap-user-1', 'secret', 'group-1', 'auth-2');
  });
});
