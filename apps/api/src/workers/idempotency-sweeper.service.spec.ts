import { IdempotencySweeperService } from './idempotency-sweeper.service';
import { PrismaService } from '../config/prisma.service';

describe('IdempotencySweeperService', () => {
  it('deletes expired keys and returns the count', async () => {
    const prisma = {
      idempotencyKey: { deleteMany: jest.fn().mockResolvedValue({ count: 7 }) },
      telegramUpdateCursor: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
      telegramIdentitySuppression: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
    } as unknown as PrismaService;
    const svc = new IdempotencySweeperService(prisma);

    const count = await svc.sweep();

    expect(count).toBe(12);
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) } },
    });
    expect(prisma.telegramUpdateCursor.deleteMany).toHaveBeenCalledWith({
      where: { updatedAt: { lt: expect.any(Date) } },
    });
    expect(prisma.telegramIdentitySuppression.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) } },
    });
  });

  it('swallows DB errors so the timer keeps running', async () => {
    const prisma = {
      idempotencyKey: { deleteMany: jest.fn().mockRejectedValue(new Error('connection refused')) },
      telegramUpdateCursor: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      telegramIdentitySuppression: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaService;
    const svc = new IdempotencySweeperService(prisma);

    await expect(svc.sweep()).resolves.toBe(0);
  });
});
