import { Injectable, Logger } from '@nestjs/common';
import { AlertStatus, PrivacyLevel } from '@prisma/client';
import { PrismaService } from '../config/prisma.service';
import { TelegramApiError, TelegramService } from '../telegram/telegram.service';

@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);
  constructor(private prisma: PrismaService, private telegram: TelegramService) {}

  /**
   * Delivers one trade alert. Never throws: a failed send must not abort the
   * surrounding sync (which may still have other accounts/members to process).
   *  - success -> mark SENT, return true
   *  - permanent failure (chat gone, bot removed/blocked: 4xx except 429) -> mark SKIPPED
   *  - transient failure (5xx/429/network) -> leave PENDING so the next sync retries
   */
  async sendTradeAlert(tradeEventId: string): Promise<boolean> {
    const event = await this.prisma.tradeEvent.findUniqueOrThrow({
      where: { id: tradeEventId },
      include: { user: true, group: true, account: { include: { connection: true } } },
    });
    if (!event.groupId || !event.group) return this.mark(event.id, 'SKIPPED'), false;
    const member = await this.prisma.groupMember.findUnique({ where: { userId_groupId: { userId: event.userId, groupId: event.groupId } } });
    if (!member?.alertsEnabled || member.privacyLevel === 'OFF') return this.mark(event.id, 'SKIPPED'), false;
    const text = this.render(event, member.privacyLevel);
    try {
      const sent = await this.telegram.sendMessage(event.group.telegramChatId, text);
      await this.prisma.alert.create({ data: { tradeEventId: event.id, groupId: event.groupId, renderedText: text, messageId: sent.message_id ? String(sent.message_id) : undefined, sentAt: new Date() } });
      await this.mark(event.id, 'SENT');
      return true;
    } catch (e) {
      const status = e instanceof TelegramApiError ? e.status : undefined;
      if (status && status >= 400 && status < 500 && status !== 429) {
        this.logger.warn(`permanent alert failure for trade ${event.id} (HTTP ${status}); marking SKIPPED`);
        await this.mark(event.id, 'SKIPPED');
        return false;
      }
      this.logger.warn(`transient alert failure for trade ${event.id}: ${(e as Error).message}; staying PENDING for retry`);
      return false;
    }
  }

  private async mark(id: string, status: AlertStatus) {
    await this.prisma.tradeEvent.update({ where: { id }, data: { alertStatus: status } });
  }

  private render(event: any, level: PrivacyLevel): string {
    const emoji = event.side === 'BUY' ? '🟢' : '🔴';
    const verb = event.side === 'BUY' ? 'bought' : 'sold';
    const actor = level === 'PRIVATE' ? 'Anonymous member' : event.user.displayName;
    const lines = [`${emoji} ${this.escape(actor)} ${verb} ${this.escape(event.symbol)}`];
    if (level === 'PUBLIC') {
      const details = [event.quantity ? `${event.quantity.toString()} shares` : null, event.price ? `@ $${Number(event.price).toFixed(2)}` : null].filter(Boolean).join(' ');
      if (details) lines.push(details);
    }
    if (level !== 'PRIVATE' && event.account?.connection?.brokerageName) lines.push(`Broker: ${this.escape(event.account.connection.brokerageName)}`);
    lines.push(`Time: ${new Date(event.tradeTime).toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
    lines.push('Read-only social alert. Not financial advice.');
    return lines.join('\n');
  }

  private escape(v: string): string {
    return v.replace(/[&<>]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[s]!));
  }
}
