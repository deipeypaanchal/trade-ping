import { Body, Controller, Get, Header, Headers, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CryptoService } from '../security/crypto.service';
import { PrismaService } from '../config/prisma.service';
import { stableStringify } from '../security/stable-json';

type SnapWebhook = { eventTimestamp?: string; userId?: string; eventType?: string; [key: string]: unknown };

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
    const expected = this.crypto.hmacBase64(this.config.getOrThrow<string>('SNAPTRADE_CONSUMER_KEY'), canonical);
    if (!this.crypto.safeEqual(signature, expected)) throw new UnauthorizedException('Invalid SnapTrade signature');
    const age = body.eventTimestamp ? Date.now() - new Date(body.eventTimestamp).getTime() : NaN;
    if (!Number.isFinite(age) || age > 5 * 60_000) throw new UnauthorizedException('Stale SnapTrade webhook');
    await this.prisma.auditLog.create({ data: { action: 'snaptrade_webhook_received', metadata: { eventType: body.eventType, eventTimestamp: body.eventTimestamp, userId: body.userId } } });
    const userId = body.userId ? String(body.userId) : undefined;
    if (userId) {
      const user = await this.prisma.user.findFirst({ where: { snaptradeUserId: userId }, select: { id: true } });
      if (user) await this.queue.add('sync-user', { userId: user.id }, { removeOnComplete: 100, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
    } else {
      await this.queue.add('sync-all', {}, { removeOnComplete: 100, attempts: 3 });
    }
    return { ok: true };
  }
}
