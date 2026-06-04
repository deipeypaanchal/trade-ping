import { Injectable, Logger } from '@nestjs/common';
import { AlertStatus, PrivacyLevel } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../config/prisma.service';
import { ALERT, TIME } from '../config/constants';
import { AssetType, contractMultiplier, isOptionSymbol } from '../broker/asset-type';
import { TelegramApiError, TelegramService } from '../telegram/telegram.service';
import { RenderableTrade } from './alert.types';
import { supportsProvisionalPositionAlerts } from '../broker/broker-freshness';

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
    if (event.alertStatus !== 'PENDING') {
      this.logger.log(`skipping trade ${event.id}; alert status is already ${event.alertStatus}`);
      return false;
    }
    if (!event.groupId || !event.group) return this.mark(event.id, 'SKIPPED'), false;
    const member = await this.prisma.groupMember.findUnique({ where: { userId_groupId: { userId: event.userId, groupId: event.groupId } } });
    if (!member?.alertsEnabled || member.privacyLevel === 'OFF') return this.mark(event.id, 'SKIPPED'), false;
    if (this.isInferred(event) && !this.isProvisional(event)) {
      this.logger.warn(`skipping inferred trade ${event.id}; holdings changes are diagnostic-only`);
      await this.mark(event.id, 'SKIPPED');
      return false;
    }
    if (this.isProvisional(event) && await this.hasMatchingConfirmedExecution(event)) {
      this.logger.log(`skipping provisional trade ${event.id}; matching confirmed execution already exists`);
      await this.mark(event.id, 'SKIPPED');
      return false;
    }

    if (this.isAlertExpired(event)) {
      this.logger.warn(`giving up on trade ${event.id} after ${event.alertAttempts ?? 0} attempt(s) / age cap`);
      await this.markAndStampAttempt(event.id, 'SKIPPED');
      return false;
    }

    const text = this.render(event, member.privacyLevel);
    if (!this.isInferred(event) && await this.tryUpgradeProvisional(event, text)) return true;
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

  private isProvisional(event: RenderableTrade): boolean {
    return this.isInferred(event)
      && event.group?.inferredAlertsEnabled === true
      && supportsProvisionalPositionAlerts(event.account?.connection ?? {});
  }

  private async tryUpgradeProvisional(event: RenderableTrade, text: string): Promise<boolean> {
    if (!event.groupId || !event.group || !event.account || !event.quantity) return false;
    const windowMs = ALERT.PROVISIONAL_EXECUTION_MATCH_WINDOW_MS;
    const provisional = await this.prisma.tradeEvent.findFirst({
      where: {
        userId: event.userId,
        groupId: event.groupId,
        accountId: event.account.id,
        symbol: event.symbol,
        side: event.side,
        quantity: event.quantity,
        rawType: 'position_delta',
        rawStatus: 'INFERRED',
        alertStatus: 'SENT',
        createdAt: {
          gte: new Date(event.tradeTime.getTime() - windowMs),
          lte: new Date(event.tradeTime.getTime() + windowMs),
        },
        alerts: { some: { messageId: { not: null } } },
      },
      include: { alerts: { where: { messageId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });
    const provisionalAlert = provisional?.alerts[0];
    const messageId = provisionalAlert?.messageId ? Number(provisionalAlert.messageId) : NaN;
    if (!provisional || !provisionalAlert || !Number.isInteger(messageId)) return false;
    try {
      await this.telegram.editMessageText(event.group.telegramChatId, messageId, text);
    } catch (err) {
      this.logger.warn(`could not upgrade provisional alert ${provisionalAlert.id}: ${(err as Error).message}; sending confirmed alert separately`);
      return false;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.alert.update({ where: { id: provisionalAlert.id }, data: { renderedText: text } });
      await tx.alert.create({ data: { tradeEventId: event.id, groupId: event.groupId!, renderedText: text, messageId: String(messageId), sentAt: new Date() } });
      await tx.tradeEvent.update({
        where: { id: event.id },
        data: { alertStatus: 'SENT', alertAttempts: { increment: 1 }, lastAlertAttemptAt: new Date() },
      });
      await tx.auditLog.create({
        data: { userId: event.userId, action: 'provisional_alert_upgraded', metadata: { provisionalTradeEventId: provisional.id, confirmedTradeEventId: event.id, messageId } },
      });
    });
    return true;
  }

  private async hasMatchingConfirmedExecution(event: RenderableTrade): Promise<boolean> {
    if (!event.groupId || !event.account || !event.quantity) return false;
    const windowMs = ALERT.PROVISIONAL_EXECUTION_MATCH_WINDOW_MS;
    return (await this.prisma.tradeEvent.count({
      where: {
        userId: event.userId,
        groupId: event.groupId,
        accountId: event.account.id,
        symbol: event.symbol,
        side: event.side,
        quantity: event.quantity,
        rawType: { not: 'position_delta' },
        rawStatus: { not: 'INFERRED' },
        tradeTime: {
          gte: new Date(event.tradeTime.getTime() - windowMs),
          lte: new Date(event.tradeTime.getTime() + windowMs),
        },
      },
    })) > 0;
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
    if (this.isProvisional(event)) return this.renderProvisional(event, level);
    const emoji = event.side === 'BUY' ? '🟢' : '🔴';
    const actor = level === 'PRIVATE' ? 'Anonymous member' : event.user.displayName;
    const verb = event.side === 'BUY' ? 'bought' : 'sold';
    const headline = this.headlineSubject(event);
    const broker = event.account?.connection?.brokerageName;
    const lines = [
      `<b>${emoji} ${this.escape(actor)} ${verb} ${this.escape(headline)}</b>`,
      [broker ? this.escape(broker) : null, 'Broker-confirmed'].filter(Boolean).join(' · '),
    ];
    if (level !== 'PRIVATE') {
      const details = this.tradeDetails(event, level);
      if (details) lines.push('', details);
    }
    const tz = event.user?.timeZone || TIME.DEFAULT_TIMEZONE;
    lines.push('', `Executed · ${this.formatTimestamp(event.tradeTime, tz)}`);
    if (this.isDelayed(event)) lines.push(`Received · ${this.formatTimestamp(event.createdAt, tz)}`);
    lines.push('', `${this.isDelayed(event) ? '◷ Delayed broker-confirmed alert' : '✓ Broker-confirmed alert'} · Read-only · Not financial advice`);
    return lines.join('\n');
  }

  private renderProvisional(event: RenderableTrade, level: PrivacyLevel): string {
    const actor = level === 'PRIVATE' ? 'Anonymous member' : event.user.displayName;
    const broker = event.account?.connection?.brokerageName;
    const direction = event.side === 'BUY' ? 'INCREASE' : 'DECREASE';
    const verb = event.side === 'BUY' ? 'increased' : 'decreased';
    const lines = [
      `<b>🟡 ${this.escape(actor)} ${verb} ${this.escape(this.headlineSubject(event))}</b>`,
      [broker ? this.escape(broker) : null, `Provisional position ${direction.toLowerCase()}`].filter(Boolean).join(' · '),
    ];
    if (level !== 'PRIVATE' && event.quantity) {
      const quantity = this.formatQuantity(event.quantity, this.assetType(event));
      lines.push('', `Observed change · ${event.side === 'BUY' ? '+' : '-'}${this.provisionalQuantity(quantity, event.symbol, this.assetType(event))}`);
      lines.push('Execution price · Unavailable');
    }
    const tz = event.user?.timeZone || TIME.DEFAULT_TIMEZONE;
    lines.push('', `Detected · ${this.formatTimestamp(event.createdAt, tz)}`);
    lines.push('', '◷ Provisional holdings change · Waiting for broker execution details');
    return lines.join('\n');
  }

  /** Human-readable subject — prefers a clean options description over the raw OCC ticker. */
  private headlineSubject(event: RenderableTrade): string {
    if (this.assetType(event) !== 'OPTION') return event.symbol;
    const underlying = event.underlying || event.symbol;
    const type = event.optionType ? this.titleCase(event.optionType) : '';
    const strike = event.optionStrike !== null && event.optionStrike !== undefined ? `$${this.formatDecimal(event.optionStrike, 2)} ` : '';
    return `${underlying} ${strike}${type}`.replace(/\s+/g, ' ').trim();
  }

  private tradeDetails(event: RenderableTrade, level: PrivacyLevel): string | null {
    const assetType = this.assetType(event);
    const quantity = event.quantity ? this.formatQuantity(event.quantity, assetType) : null;
    const price = event.price ? this.formatPrice(event.price, assetType) : null;
    const value = event.quantity && event.price ? this.formatCurrency(this.tradeValue(event)) : null;
    const quantityLine = quantity ? this.quantityLine(quantity, price, event.symbol, assetType) : null;
    const details = [
      assetType === 'OPTION' && event.optionExpiration ? `Expires · ${this.formatExpiry(event.optionExpiration)}` : null,
      quantityLine,
      value ? `Total ${event.side === 'BUY' ? 'debit' : 'credit'} · ${value}` : null,
      ...(level === 'PUBLIC' ? this.profitDetails(event) : []),
    ].filter(Boolean);
    return details.length ? details.join('\n') : null;
  }

  private profitDetails(event: RenderableTrade): string[] {
    if (event.side !== 'SELL') return [];
    if (event.profitLoss !== null && event.profitLoss !== undefined) {
      const amount = this.decimal(event.profitLoss);
      const pct = event.profitLossPct !== null && event.profitLossPct !== undefined ? this.decimal(event.profitLossPct) : null;
      const pctText = pct ? ` (${pct.greaterThanOrEqualTo(0) ? '+' : ''}${pct.toFixed(2)}%)` : '';
      return [`Est. return · ${this.formatSignedCurrency(amount)}${pctText}`];
    }
    return [];
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
    return `$${this.withGrouping(value.toFixed(2))}`;
  }

  private formatSignedCurrency(value: Decimal): string {
    const prefix = value.greaterThanOrEqualTo(0) ? '+' : '-';
    return `${prefix}$${this.withGrouping(value.abs().toFixed(2))}`;
  }

  private tradeValue(event: RenderableTrade): Decimal {
    return this.decimal(event.quantity).mul(this.decimal(event.price)).mul(this.valueMultiplier(event));
  }

  private valueMultiplier(event: RenderableTrade): number {
    return event.priceSource === 'EXECUTION' ? contractMultiplier(this.assetType(event), String(event.symbol)) : 1;
  }

  private assetType(event: RenderableTrade): AssetType {
    if (event.account?.accountType?.toUpperCase() === 'DIGITALASSET') return 'CRYPTO';
    if (typeof event.assetType === 'string' && event.assetType) return event.assetType as AssetType;
    return isOptionSymbol(String(event.symbol)) ? 'OPTION' : 'EQUITY';
  }

  private quantityLine(quantity: string, price: string | null, symbol: string, assetType: AssetType): string {
    const unit = assetType === 'OPTION'
      ? this.plural(quantity, 'contract')
      : assetType === 'CRYPTO'
        ? this.escape(symbol)
        : this.plural(quantity, 'share');
    return price
      ? `${quantity} ${unit} @ $${price}${assetType === 'OPTION' ? ' premium' : ''}`
      : `${quantity} ${unit} · Execution price unavailable`;
  }

  private provisionalQuantity(quantity: string, symbol: string, assetType: AssetType): string {
    if (assetType === 'OPTION') return `${quantity} ${this.plural(quantity, 'contract')}`;
    if (assetType === 'CRYPTO') return `${quantity} ${this.escape(symbol)}`;
    return `${quantity} ${this.plural(quantity, 'share')}`;
  }

  private formatQuantity(value: Decimal, assetType: AssetType): string {
    return this.trimDecimal(value, assetType === 'CRYPTO' ? 8 : 6, 0);
  }

  private formatPrice(value: Decimal, assetType: AssetType): string {
    return this.withGrouping(this.trimDecimal(value, assetType === 'CRYPTO' ? 8 : assetType === 'EQUITY' ? 4 : 2, 2));
  }

  private trimDecimal(value: Decimal, maxFractionDigits: number, minFractionDigits: number): string {
    const fixed = value.toFixed(maxFractionDigits);
    const [whole, fraction = ''] = fixed.split('.');
    const trimmed = fraction.replace(/0+$/, '');
    const kept = trimmed.padEnd(minFractionDigits, '0');
    return kept ? `${whole}.${kept}` : whole;
  }

  private withGrouping(value: string): string {
    const [whole, fraction] = value.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return fraction === undefined ? grouped : `${grouped}.${fraction}`;
  }

  private plural(quantity: string, singular: string): string {
    return quantity === '1' ? singular : `${singular}s`;
  }

  private formatTimestamp(value: Date, timeZone: string): string {
    return new Date(value).toLocaleString('en-US', {
      timeZone,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  }

  private isDelayed(event: Pick<RenderableTrade, 'createdAt' | 'tradeTime'>): boolean {
    return event.createdAt.getTime() - event.tradeTime.getTime() >= ALERT.DELAYED_FEED_THRESHOLD_MS;
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
