import { Injectable, Logger } from '@nestjs/common';
import { AlertStatus, PrivacyLevel } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../config/prisma.service';
import { ALERT, TIME } from '../config/constants';
import { AssetType, contractMultiplier, isOptionSymbol } from '../broker/asset-type';
import { TelegramApiError, TelegramService } from '../telegram/telegram.service';
import { RenderableTrade } from './alert.types';

@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);
  constructor(private prisma: PrismaService, private telegram: TelegramService) {}

  /**
   * Delivers one trade alert. Never throws: a failed send must not abort the
   * surrounding sync (which may still have other accounts/members to process).
   *  - success -> mark SENT, return true
   *  - permanent failure (chat gone, bot removed/blocked: 4xx except 429) -> mark SKIPPED
   *  - transient failure (5xx/429/network) -> bump attempts, stay PENDING for retry
   *    UNTIL we hit ALERT.MAX_ATTEMPTS or the trade is older than ALERT.MAX_AGE_MS,
   *    at which point we mark SKIPPED so a Telegram outage can't replay old fills
   *    forever once it recovers.
   */
  async sendTradeAlert(tradeEventId: string): Promise<boolean> {
    const event = (await this.prisma.tradeEvent.findUniqueOrThrow({
      where: { id: tradeEventId },
      include: { user: true, group: true, account: { include: { connection: true } } },
    })) as unknown as RenderableTrade;
    if (!event.groupId || !event.group) return this.mark(event.id, 'SKIPPED'), false;
    const member = await this.prisma.groupMember.findUnique({ where: { userId_groupId: { userId: event.userId, groupId: event.groupId } } });
    if (!member?.alertsEnabled || member.privacyLevel === 'OFF') return this.mark(event.id, 'SKIPPED'), false;
    if (this.isInferred(event)) {
      this.logger.warn(`skipping inferred trade ${event.id}; group alerts require broker execution records`);
      await this.mark(event.id, 'SKIPPED');
      return false;
    }

    if (this.isAlertExpired(event)) {
      this.logger.warn(`giving up on trade ${event.id} after ${event.alertAttempts ?? 0} attempt(s) / age cap`);
      await this.markAndStampAttempt(event.id, 'SKIPPED');
      return false;
    }

    const text = this.render(event, member.privacyLevel);
    try {
      const sent = await this.telegram.sendMessage(event.group.telegramChatId, text);
      await this.prisma.alert.create({ data: { tradeEventId: event.id, groupId: event.groupId, renderedText: text, messageId: sent.message_id ? String(sent.message_id) : undefined, sentAt: new Date() } });
      await this.markAndStampAttempt(event.id, 'SENT');
      return true;
    } catch (e) {
      const status = e instanceof TelegramApiError ? e.status : undefined;
      if (status && status >= 400 && status < 500 && status !== 429) {
        this.logger.warn(`permanent alert failure for trade ${event.id} (HTTP ${status}); marking SKIPPED`);
        await this.markAndStampAttempt(event.id, 'SKIPPED');
        return false;
      }
      this.logger.warn(`transient alert failure for trade ${event.id}: ${(e as Error).message}; staying PENDING for retry`);
      await this.stampAttempt(event.id);
      return false;
    }
  }

  private isAlertExpired(event: { alertAttempts: number | null; tradeTime: Date; createdAt: Date; rawStatus: string | null; rawType: string | null }): boolean {
    const attempts = event.alertAttempts ?? 0;
    if (attempts >= ALERT.MAX_ATTEMPTS) return true;
    const anchor = event.tradeTime ?? event.createdAt;
    return Date.now() - anchor.getTime() > ALERT.MAX_AGE_MS;
  }

  private isInferred(event: { rawStatus: string | null; rawType: string | null }): boolean {
    return event.rawType === 'position_delta' || event.rawStatus === 'INFERRED';
  }

  private async mark(id: string, status: AlertStatus) {
    await this.prisma.tradeEvent.update({ where: { id }, data: { alertStatus: status } });
  }

  private async markAndStampAttempt(id: string, status: AlertStatus) {
    await this.prisma.tradeEvent.update({
      where: { id },
      data: { alertStatus: status, alertAttempts: { increment: 1 }, lastAlertAttemptAt: new Date() },
    });
  }

  private async stampAttempt(id: string) {
    await this.prisma.tradeEvent.update({
      where: { id },
      data: { alertAttempts: { increment: 1 }, lastAlertAttemptAt: new Date() },
    });
  }

  private render(event: RenderableTrade, level: PrivacyLevel): string {
    const emoji = event.side === 'BUY' ? '🟢' : '🔴';
    const verb = event.side === 'BUY' ? 'bought' : 'sold';
    const actor = level === 'PRIVATE' ? 'Anonymous member' : event.user.displayName;
    const headline = this.headlineSubject(event);
    const lines = [`${emoji} ${this.escape(actor)} ${verb} ${this.escape(headline)}`];
    if (level !== 'PRIVATE') {
      const details = this.tradeDetails(event, level);
      if (details) lines.push(details);
    }
    if (level !== 'PRIVATE' && event.account?.connection?.brokerageName) lines.push(`Broker: ${this.escape(event.account.connection.brokerageName)}`);
    const tz = event.user?.timeZone || TIME.DEFAULT_TIMEZONE;
    lines.push(`Time: ${new Date(event.tradeTime).toLocaleString('en-US', { timeZone: tz })}`);
    lines.push('Read-only social alert. Not financial advice.');
    return lines.join('\n');
  }

  /** Human-readable subject — prefers a clean options description over the raw OCC ticker. */
  private headlineSubject(event: RenderableTrade): string {
    if (this.assetType(event) !== 'OPTION') return event.symbol;
    const underlying = event.underlying || event.symbol;
    const type = event.optionType ? this.titleCase(event.optionType) : '';
    const strike = event.optionStrike !== null && event.optionStrike !== undefined ? `$${this.formatDecimal(event.optionStrike, 2)} ` : '';
    const expiry = event.optionExpiration ? ` exp ${this.formatExpiry(event.optionExpiration)}` : '';
    return `${underlying} ${strike}${type}${expiry}`.replace(/\s+/g, ' ').trim();
  }

  private tradeDetails(event: RenderableTrade, level: PrivacyLevel): string | null {
    const quantity = event.quantity ? this.formatDecimal(event.quantity) : null;
    const price = event.price ? this.formatDecimal(event.price, 2) : null;
    const value = event.quantity && event.price ? this.formatCurrency(this.tradeValue(event)) : null;
    const isOption = this.assetType(event) === 'OPTION';
    const qtyLabel = isOption ? 'Contracts' : 'Qty';
    const priceSuffix = isOption && event.priceSource === 'EXECUTION' ? ' premium' : '';
    const details = [
      quantity ? `${qtyLabel}: ${quantity}` : null,
      level === 'PUBLIC' && price ? `Avg fill: $${price}${priceSuffix}` : null,
      value ? `Notional: ${value}` : null,
      ...(level === 'PUBLIC' ? this.profitDetails(event) : []),
    ].filter(Boolean);
    return details.length ? details.join('\n') : null;
  }

  private profitDetails(event: RenderableTrade): string[] {
    if (event.side !== 'SELL') return [];
    if (event.profitLoss !== null && event.profitLoss !== undefined) {
      const amount = this.decimal(event.profitLoss);
      const pct = event.profitLossPct !== null && event.profitLossPct !== undefined ? this.decimal(event.profitLossPct) : null;
      const label = amount.greaterThanOrEqualTo(0) ? 'Est. profit' : 'Est. loss';
      const pctText = pct ? ` (${pct.greaterThanOrEqualTo(0) ? '+' : ''}${pct.toFixed(2)}%)` : '';
      return [`${label}: ${this.formatSignedCurrency(amount)}${pctText}`];
    }
    return ['P/L unavailable; cost basis missing.'];
  }

  /** Decimal-safe formatter. Avoid Number() coercion that would lose precision on large values. */
  private formatDecimal(value: unknown, fractionDigits?: number): string {
    if (value instanceof Decimal) return fractionDigits === undefined ? value.toString() : value.toFixed(fractionDigits);
    if (typeof value === 'string' || typeof value === 'number') {
      try {
        const d = this.decimal(value);
        return fractionDigits === undefined ? d.toString() : d.toFixed(fractionDigits);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  private formatCurrency(value: Decimal): string {
    return `$${value.toFixed(2)}`;
  }

  private formatSignedCurrency(value: Decimal): string {
    const prefix = value.greaterThanOrEqualTo(0) ? '+' : '-';
    return `${prefix}$${value.abs().toFixed(2)}`;
  }

  private tradeValue(event: RenderableTrade): Decimal {
    return this.decimal(event.quantity).mul(this.decimal(event.price)).mul(this.valueMultiplier(event));
  }

  private valueMultiplier(event: RenderableTrade): number {
    return event.priceSource === 'EXECUTION' ? contractMultiplier(this.assetType(event), String(event.symbol)) : 1;
  }

  private assetType(event: RenderableTrade): AssetType {
    if (typeof event.assetType === 'string' && event.assetType) return event.assetType as AssetType;
    return isOptionSymbol(String(event.symbol)) ? 'OPTION' : 'EQUITY';
  }

  private titleCase(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  private formatExpiry(value: unknown): string {
    const d = value instanceof Date ? value : new Date(String(value));
    if (!Number.isFinite(d.getTime())) return String(value);
    // "Mar 21, 2025" — unambiguous and short.
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  private decimal(value: unknown): Decimal {
    return value instanceof Decimal ? value : new Decimal(value as Decimal.Value);
  }

  private escape(v: string): string {
    return v
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
