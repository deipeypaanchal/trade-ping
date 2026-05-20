import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Request } from 'express';
import { PrismaService } from '../config/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { SnaptradeWebhookController } from './snaptrade-webhook.controller';

describe('SnaptradeWebhookController', () => {
  const crypto = new CryptoService();
  const config = new ConfigService({ SNAPTRADE_CONSUMER_KEY: 'consumer-secret' });
  const prisma = {
    auditLog: { create: jest.fn() },
    user: { findFirst: jest.fn() },
  } as unknown as PrismaService;
  const queue = { add: jest.fn() } as unknown as Queue;
  const controller = new SnaptradeWebhookController(crypto, config, prisma, queue);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('verifies signatures against the raw request body', async () => {
    const rawBody = `{"userId":"snap-user","eventTimestamp":"${new Date().toISOString()}","eventType":"ORDER"}`;
    const body = JSON.parse(rawBody);
    const signature = crypto.hmacBase64('consumer-secret', rawBody);
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'app-user' } as never);

    await expect(controller.webhook(body, signature, { rawBody } as Request & { rawBody?: string })).resolves.toEqual({ ok: true });

    expect(queue.add).toHaveBeenCalledWith('sync-user', { userId: 'app-user' }, expect.any(Object));
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'snaptrade_webhook_received',
        metadata: { eventType: 'ORDER', eventTimestamp: body.eventTimestamp, userId: 'snap-user' },
      },
    });
  });

  it('rejects stale webhooks', async () => {
    const rawBody = JSON.stringify({ eventTimestamp: new Date(Date.now() - 10 * 60_000).toISOString() });
    const signature = crypto.hmacBase64('consumer-secret', rawBody);

    await expect(controller.webhook(JSON.parse(rawBody), signature, { rawBody } as Request & { rawBody?: string })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
