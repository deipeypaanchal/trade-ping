import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports both Postgres and Redis readiness', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const redis = { ping: jest.fn().mockResolvedValue('PONG') };
    const queue = { client: Promise.resolve(redis) };

    await expect(new HealthController(prisma as never, queue as never).health()).resolves.toEqual(expect.objectContaining({
      ok: true,
      checks: { database: 'up', redis: 'up' },
    }));
  });

  it('returns unavailable when Redis cannot schedule work', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const redis = { ping: jest.fn().mockRejectedValue(new Error('connection refused')) };
    const queue = { client: Promise.resolve(redis) };

    await expect(new HealthController(prisma as never, queue as never).health()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
