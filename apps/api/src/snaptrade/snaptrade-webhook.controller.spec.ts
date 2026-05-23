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
    user: { findUnique: jest.fn(), delete: jest.fn() },
    brokerConnection: { updateMany: jest.fn() },
    idempotencyKey: { create: jest.fn() },
  } as unknown as PrismaService;
  const queue = { add: jest.fn() } as unknown as Queue;
  const controller = new SnaptradeWebhookController(crypto, config, prisma, queue);

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.idempotencyKey.create as jest.Mock).mockResolvedValue({ key: 'x' });
  });

  it('verifies signatures against the raw request body', async () => {
    const rawBody = `{"userId":"snap-user","eventTimestamp":"${new Date().toISOString()}","eventType":"ACCOUNT_HOLDINGS_UPDATED"}`;
    const body = JSON.parse(rawBody);
    const signature = crypto.hmacBase64('consumer-secret', rawBody);
    jest.spyOn(prisma.user, 'findUnique').mockResolvedValue({ id: 'app-user' } as never);

    await expect(controller.webhook(body, signature, { rawBody } as Request & { rawBody?: string })).resolves.toEqual({ ok: true });

    expect(queue.add).toHaveBeenCalledWith(
      'sync-user',
      { userId: 'app-user' },
      expect.objectContaining({ jobId: expect.stringMatching(/^sync-user:app-user:[a-f0-9]{16}$/) }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'snaptrade_webhook_received',
        metadata: { eventType: 'ACCOUNT_HOLDINGS_UPDATED', eventTimestamp: body.eventTimestamp, userId: 'snap-user' },
      },
    });
  });

  it('rejects stale webhooks', async () => {
    const rawBody = JSON.stringify({ eventTimestamp: new Date(Date.now() - 10 * 60_000).toISOString() });
    const signature = crypto.hmacBase64('consumer-secret', rawBody);

    await expect(controller.webhook(JSON.parse(rawBody), signature, { rawBody } as Request & { rawBody?: string })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('treats a duplicate signature as a replay and short-circuits', async () => {
    const rawBody = `{"userId":"snap-user","eventTimestamp":"${new Date().toISOString()}","eventType":"ACCOUNT_HOLDINGS_UPDATED"}`;
    const body = JSON.parse(rawBody);
    const signature = crypto.hmacBase64('consumer-secret', rawBody);
    (prisma.idempotencyKey.create as jest.Mock).mockRejectedValueOnce(new Error('unique violation'));

    await expect(controller.webhook(body, signature, { rawBody } as Request & { rawBody?: string })).resolves.toEqual({ ok: true, replay: true });
    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('USER_DELETED: tolerates P2025 (already deleted) and returns ok', async () => {
    const rawBody = `{"userId":"snap-user","eventTimestamp":"${new Date().toISOString()}","eventType":"USER_DELETED"}`;
    const body = JSON.parse(rawBody);
    const signature = crypto.hmacBase64('consumer-secret', rawBody);
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'app-user' });
    (prisma.user.delete as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'P2025' }));

    await expect(controller.webhook(body, signature, { rawBody } as Request & { rawBody?: string })).resolves.toEqual({ ok: true });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('USER_DELETED: rethrows non-P2025 errors so SnapTrade retries', async () => {
    const rawBody = `{"userId":"snap-user","eventTimestamp":"${new Date().toISOString()}","eventType":"USER_DELETED"}`;
    const body = JSON.parse(rawBody);
    const signature = crypto.hmacBase64('consumer-secret', rawBody);
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'app-user' });
    (prisma.user.delete as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('FK violation'), { code: 'P2003' }));

    await expect(
      controller.webhook(body, signature, { rawBody } as Request & { rawBody?: string }),
    ).rejects.toThrow(/FK violation/);
  });
});
