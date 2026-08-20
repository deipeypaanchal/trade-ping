import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports both Postgres and Redis readiness', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const redis = { ping: jest.fn().mockResolvedValue('PONG') };
    const queue = { client: Promise.resolve(redis) };
    const config = {
      get: jest.fn((key: string) => key === 'RELEASE_SHA'
        ? 'abc1234'
        : key === 'RAILWAY_DEPLOYMENT_ID'
          ? '019c92ba-3e22-7c2a-a57c-89f03b330a51'
          : undefined),
    };

    await expect(new HealthController(prisma as never, queue as never, config as never).health()).resolves.toEqual(expect.objectContaining({
      ok: true,
      service: 'tradeping-api',
      release: 'abc1234',
      deploymentId: '019c92ba-3e22-7c2a-a57c-89f03b330a51',
      startedAt: expect.any(String),
      uptimeSeconds: expect.any(Number),
      checks: { database: 'up', redis: 'up' },
    }));
  });

  it('returns unavailable when Redis cannot schedule work', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const redis = { ping: jest.fn().mockRejectedValue(new Error('connection refused')) };
    const queue = { client: Promise.resolve(redis) };
    const config = { get: jest.fn().mockReturnValue(undefined) };

    try {
      await new HealthController(prisma as never, queue as never, config as never).health();
      throw new Error('expected health to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getResponse()).toEqual(expect.objectContaining({
        ok: false,
        checks: {
          database: 'up',
          redis: 'down',
        },
      }));
    }
  });

  it('returns unavailable when Postgres is down but still reports Redis', async () => {
    const prisma = { $queryRaw: jest.fn().mockRejectedValue(new Error('db refused')) };
    const redis = { ping: jest.fn().mockResolvedValue('PONG') };
    const queue = { client: Promise.resolve(redis) };
    const config = { get: jest.fn().mockReturnValue(undefined) };

    try {
      await new HealthController(prisma as never, queue as never, config as never).health();
      throw new Error('expected health to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getResponse()).toEqual(expect.objectContaining({
        ok: false,
        checks: {
          database: 'down',
          redis: 'up',
        },
      }));
    }
  });

  it('reports liveness without dependency checks', () => {
    const prisma = {};
    const queue = {};
    const config = { get: jest.fn().mockReturnValue(undefined) };

    expect(new HealthController(prisma as never, queue as never, config as never).livez()).toEqual(expect.objectContaining({
      ok: true,
      service: 'tradeping-api',
      release: null,
      deploymentId: null,
      startedAt: expect.any(String),
      uptimeSeconds: expect.any(Number),
    }));
  });
});
