import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountController } from './account.controller';
import { PrismaService } from '../config/prisma.service';
import { BrokerOnboardingService } from '../broker/broker-onboarding.service';

const SECRET = 'a'.repeat(32);

function makeController() {
  const prisma = {
    user: { findUnique: jest.fn(), delete: jest.fn() },
  } as unknown as PrismaService;
  const broker = { disconnectAll: jest.fn() } as unknown as BrokerOnboardingService;
  const config = new ConfigService({ INTERNAL_JOB_SECRET: SECRET });
  return { controller: new AccountController(prisma, broker, config), prisma, broker };
}

describe('AccountController DELETE /account/delete', () => {
  it('rejects requests missing auth header', async () => {
    const { controller } = makeController();
    await expect(controller.deleteAccount({ userId: 'x' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when neither userId nor telegramUserId is provided (no silent no-op)', async () => {
    const { controller } = makeController();
    await expect(controller.deleteAccount({}, `Bearer ${SECRET}`)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when BOTH userId and telegramUserId are provided (confused deputy guard)', async () => {
    const { controller } = makeController();
    await expect(
      controller.deleteAccount({ userId: 'alice', telegramUserId: 'bob' }, `Bearer ${SECRET}`),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deletes by userId when only userId is provided', async () => {
    const { controller, prisma, broker } = makeController();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'alice' });

    const result = await controller.deleteAccount({ userId: 'alice' }, `Bearer ${SECRET}`);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'alice' } });
    expect(broker.disconnectAll).toHaveBeenCalledWith('alice');
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'alice' } });
    expect(result).toEqual({ ok: true, deleted: true });
  });

  it('returns deleted:false (idempotent) when the user does not exist', async () => {
    const { controller, prisma, broker } = makeController();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    const result = await controller.deleteAccount({ telegramUserId: '12345' }, `Bearer ${SECRET}`);

    expect(broker.disconnectAll).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, deleted: false });
  });
});
