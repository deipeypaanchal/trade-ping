import { Body, Controller, Get, Header, Headers, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CryptoService } from '../security/crypto.service';
import { PrismaService } from '../config/prisma.service';
import { stableStringify } from '../security/stable-json';

type SnapWebhook = {
  eventTimestamp?: string;
  userId?: string;
  eventType?: string;
  brokerageAuthorizationId?: string;
  accountId?: string;
  [key: string]: unknown;
};

/**
 * SnapTrade event types we react to (https://docs.snaptrade.com/docs/webhooks).
 * For ACCOUNT_HOLDINGS_UPDATED / ACCOUNT_TRANSACTIONS_UPDATED / TRADE_DETECTION
 * we enqueue a sync for the affected user. CONNECTION_DELETED / USER_DELETED
 * are handled by mutating local state. Other events are recorded only.
 */
const SYNC_TRIGGER_EVENTS = new Set([
  'ACCOUNT_HOLDINGS_UPDATED',
  'ACCOUNT_TRANSACTIONS_INITIAL_UPDATE',
  'ACCOUNT_TRANSACTIONS_UPDATED',
  'TRADE_DETECTION',
  'TRADE_UPDATE',
  'NEW_ACCOUNT_AVAILABLE',
  'CONNECTION_ADDED',
  'CONNECTION_FIXED',
  'CONNECTION_UPDATED',
]);

@Controller('snaptrade')
export class SnaptradeWebhookController {
  constructor(private crypto: CryptoService, private config: ConfigService, private prisma: PrismaService, @InjectQueue('trade-sync') private queue: Queue) {}

  @Get('callback')
  @Header('content-type', 'text/html; charset=utf-8')
  callback(@Query('mock') mock?: string) {
    const suffix = mock === 'true' ? ' Mock mode completed.' : '';
    return `<main style="font-family: system-ui, sans-serif; max-width: 560px; margin: 64px auto; line-height: 1.5"><h1>Brokerage connected</h1><p>${suffix} You can return to Telegram and run <strong>/status</strong>.</p></main>`;
  }

  @Post('webhook')
  async webhook(@Body() body: SnapWebhook, @Headers('signature') signature: string | undefined, @Req() req: Request & { rawBody?: string }) {
    const canonical = req.rawBody ?? stableStringify(body);
    const eventJobKey = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    const expected = this.crypto.hmacBase64(this.config.getOrThrow<string>('SNAPTRADE_CONSUMER_KEY'), canonical);
    if (!this.crypto.safeEqual(signature, expected)) throw new UnauthorizedException('Invalid SnapTrade signature');
    const age = body.eventTimestamp ? Date.now() - new Date(body.eventTimestamp).getTime() : NaN;
    if (!Number.isFinite(age) || age > 5 * 60_000) throw new UnauthorizedException('Stale SnapTrade webhook');

    await this.prisma.auditLog.create({ data: { action: 'snaptrade_webhook_received', metadata: { eventType: body.eventType, eventTimestamp: body.eventTimestamp, userId: body.userId } } });

    const snapUserId = body.userId ? String(body.userId) : undefined;
    const localUser = snapUserId ? await this.prisma.user.findUnique({ where: { snaptradeUserId: snapUserId }, select: { id: true } }) : null;

    if (body.eventType === 'USER_DELETED' && localUser) {
      await this.prisma.user.delete({ where: { id: localUser.id } }).catch(() => undefined);
      return { ok: true };
    }

    if (body.eventType === 'CONNECTION_DELETED' && body.brokerageAuthorizationId) {
      await this.prisma.brokerConnection.updateMany({
        where: { authorizationId: String(body.brokerageAuthorizationId) },
        data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
      });
      return { ok: true };
    }

    if (body.eventType === 'CONNECTION_BROKEN' && body.brokerageAuthorizationId) {
      await this.prisma.brokerConnection.updateMany({
        where: { authorizationId: String(body.brokerageAuthorizationId) },
        data: { status: 'ERROR', disabledReason: 'SnapTrade reported CONNECTION_BROKEN' },
      });
      return { ok: true };
    }

    if (body.eventType && SYNC_TRIGGER_EVENTS.has(body.eventType)) {
      if (localUser) {
        // jobId dedupes exact webhook redeliveries while allowing future events for the same user.
        await this.queue.add(
          'sync-user',
          { userId: localUser.id },
          { jobId: `sync-user:${localUser.id}:${eventJobKey}`, removeOnComplete: 100, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        );
      } else if (!snapUserId) {
        await this.queue.add('sync-all', {}, { jobId: `sync-all:${eventJobKey}`, removeOnComplete: 100, attempts: 3 });
      }
    }
    return { ok: true };
  }
}
