import { BadRequestException, Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../config/prisma.service';
import { JOB_DEFAULTS, SYNC, TIME } from '../config/constants';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './telegram.types';
import { BrokerOnboardingService } from '../broker/broker-onboarding.service';
import { PrivacyService } from '../privacy/privacy.service';
import { brokerFreshnessNote, brokerFreshnessSummary } from '../broker/broker-freshness';
import { EncryptedSecretError } from '../security/errors';
import { safeEqual } from '../security/constant-time';

const VALID_PRIVACY = new Set(['PUBLIC', 'NORMAL', 'PRIVATE', 'OFF']);

@Controller('telegram')
export class TelegramController {
  constructor(
    private prisma: PrismaService,
    private telegram: TelegramService,
    private onboarding: BrokerOnboardingService,
    private privacy: PrivacyService,
    private config: ConfigService,
    @InjectQueue('trade-sync') private queue: Queue,
  ) {}

  @Post('webhook')
  async webhook(@Body() update: TelegramUpdate, @Headers('x-telegram-bot-api-secret-token') secret?: string) {
    const expected = this.config.getOrThrow<string>('TELEGRAM_WEBHOOK_SECRET');
    if (!safeEqual(secret, expected)) throw new UnauthorizedException();
    const msg = update.message;
    if (!msg) return { ok: true };

    if (msg.new_chat_members?.length) {
      await this.handleNewChatMembers(msg);
      return { ok: true };
    }

    if (!msg.text || !msg.from) return { ok: true };
    const text = msg.text.trim();
    const chatId = String(msg.chat.id);
    const user = await this.prisma.user.upsert({
      where: { telegramUserId: String(msg.from.id) },
      update: { displayName: this.displayName(msg.from) },
      create: { telegramUserId: String(msg.from.id), displayName: this.displayName(msg.from) },
    });
    const group = await this.groupFor(msg.chat);
    if (group) {
      await this.prisma.groupMember.upsert({ where: { userId_groupId: { userId: user.id, groupId: group.id } }, update: {}, create: { userId: user.id, groupId: group.id } });
    }

    try {
      if (this.cmd(text, '/connect')) {
        if (!group) {
          await this.telegram.sendMessage(chatId, 'Run /connect inside your TradePing group so alerts post there. I\'ll DM you the private link.');
          return { ok: true };
        }
        const url = await this.onboarding.createConnectUrl(user.id, group.id);
        await this.sendConnectLink(msg.chat.type, chatId, String(msg.from.id), url);
      } else if (this.cmd(text, '/reconnect')) {
        if (!group) {
          await this.telegram.sendMessage(chatId, 'Run /reconnect inside your TradePing group so the repaired connection stays linked to the right alert destination.');
          return { ok: true };
        }
        const broker = text.split(/\s+/).slice(1).join(' ') || undefined;
        const url = await this.onboarding.createReconnectUrl(user.id, group.id, broker);
        await this.sendReconnectLink(msg.chat.type, chatId, String(msg.from.id), url);
      } else if (this.cmd(text, '/privacy')) {
        if (!group) {
          await this.telegram.sendMessage(chatId, 'Privacy is per user, per group. Run /privacy public, normal, private, or off inside the TradePing group you want to change.');
          return { ok: true };
        }
        const level = text.split(/\s+/)[1]?.toUpperCase();
        if (!level || !VALID_PRIVACY.has(level)) {
          await this.telegram.sendMessage(chatId, this.privacyHelpText());
        } else {
          await this.privacy.setPrivacy(user.id, group.id, level);
          await this.telegram.sendMessage(chatId, `Alert visibility set to <b>${level}</b> for your alerts in this group.`);
        }
      } else if (this.cmd(text, '/setup') || this.cmd(text, '/guide')) {
        await this.telegram.sendMessage(chatId, this.groupSetupText(msg.chat.title), { replyMarkup: this.privateStartKeyboard() });
      } else if (this.cmd(text, '/status')) {
        if (group) {
          await this.telegram.sendMessage(chatId, await this.groupStatusText(group.id));
          return { ok: true };
        }
        await this.onboarding.refreshConnections(user.id);
        const connections = await this.prisma.brokerConnection.findMany({
          where: { userId: user.id, status: { not: 'DISCONNECTED' } },
          include: { accounts: { where: { status: { not: 'DISCONNECTED' } }, select: { id: true, accountType: true } } },
          orderBy: { updatedAt: 'desc' },
        });
        const syncStates = connections.length ? await this.syncStatesFor(connections.flatMap((c) => c.accounts.map((a) => a.id))) : new Map<string, Date>();
        const executionFreshness = connections.length ? await this.executionFreshnessFor(connections.flatMap((c) => c.accounts.map((a) => a.id))) : new Map<string, { createdAt: Date; tradeTime: Date }>();
        await this.telegram.sendMessage(chatId, this.statusText(connections, syncStates, executionFreshness));
      } else if (this.cmd(text, '/sync')) {
        const windowKey = Math.floor(Date.now() / SYNC.FANOUT_DEDUPE_WINDOW_MS);
        await this.queue.add('sync-user', { userId: user.id }, { jobId: `manual-sync-user:${user.id}:${windowKey}`, ...JOB_DEFAULTS });
        await this.telegram.sendMessage(chatId, 'Sync queued. TradePing also checks automatically in the background. Alerts appear when your broker reports fresh data; Fidelity/IBKR may be delayed up to 24h.');
      } else if (this.cmd(text, '/inferred')) {
        if (!group) {
          await this.telegram.sendMessage(chatId, 'Run /inferred on or /inferred off inside the TradePing group you want to change.');
          return { ok: true };
        }
        const mode = text.split(/\s+/)[1]?.toLowerCase();
        if (mode !== 'on' && mode !== 'off') {
          await this.telegram.sendMessage(chatId, 'Use /inferred on or /inferred off. This group-level setting controls clearly labeled provisional Robinhood holdings alerts when execution details are unavailable.');
          return { ok: true };
        }
        if (!(await this.telegram.isChatAdmin(chatId, String(msg.from.id)))) {
          await this.telegram.sendMessage(chatId, 'Only a Telegram group admin can change provisional holdings alerts.');
          return { ok: true };
        }
        const enabled = mode === 'on';
        await this.prisma.group.update({ where: { id: group.id }, data: { inferredAlertsEnabled: enabled } });
        await this.telegram.sendMessage(chatId, enabled
          ? 'Provisional Robinhood holdings alerts are <b>ON</b> for this group. These alerts are labeled as position changes, not broker-confirmed executions. Fidelity/IBKR remain diagnostic-only.'
          : 'Provisional holdings alerts are <b>OFF</b> for this group. Position-only changes will stay in diagnostics.');
      } else if (this.cmd(text, '/disconnect')) {
        try {
          const count = await this.onboarding.disconnectAll(user.id);
          await this.telegram.sendMessage(chatId, count ? `Disconnected ${count} brokerage connection(s). No more alerts until you /connect again.` : 'You had no active brokerage connections.');
        } catch (err) {
          if (err instanceof EncryptedSecretError) {
            await this.telegram.sendMessage(chatId, 'Your encrypted brokerage secret could not be read (likely a key rotation). Your alerts are paused. Please /connect again to relink.');
          } else {
            throw err;
          }
        }
      } else if (this.cmd(text, '/trust')) {
        await this.telegram.sendMessage(chatId, this.trustText());
      } else if (this.cmd(text, '/diagnostics')) {
        await this.telegram.sendMessage(chatId, await this.diagnosticsText(user.id, group?.id));
      } else if (this.cmd(text, '/groupstatus')) {
        if (!group) {
          await this.telegram.sendMessage(chatId, 'Run /groupstatus inside a TradePing group.');
          return { ok: true };
        }
        await this.telegram.sendMessage(chatId, await this.groupStatusText(group.id));
      } else if (this.cmd(text, '/help') || this.cmd(text, '/start')) {
        await this.telegram.sendMessage(chatId, this.helpText(msg.chat.type), { replyMarkup: msg.chat.type === 'private' ? undefined : this.privateStartKeyboard() });
      }
    } catch (e) {
      const command = text.split(/\s+/)[0] || 'unknown';
      const err = e as Error;
      await this.prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'telegram_command_failed',
          metadata: { command, message: err.message, name: err.name },
        },
      });
      const userMsg = e instanceof BadRequestException
        ? `Invalid input: ${err.message}`
        : 'Something went wrong. Please try again or contact the group admin.';
      await this.telegram.sendMessage(chatId, userMsg);
    }
    return { ok: true };
  }

  private cmd(text: string, command: string) { return text === command || text.startsWith(`${command} `) || text.startsWith(`${command}@`); }
  private groupFor(chat: NonNullable<TelegramUpdate['message']>['chat']) {
    if (chat.type !== 'group' && chat.type !== 'supergroup') return null;
    return this.prisma.group.upsert({
      where: { telegramChatId: String(chat.id) },
      update: { name: chat.title },
      create: { telegramChatId: String(chat.id), name: chat.title },
    });
  }

  private async handleNewChatMembers(msg: NonNullable<TelegramUpdate['message']>) {
    // Greet only once — when TradePing itself is added. Stay silent on member
    // joins so the group never gets spammed with per-join welcome messages.
    const botUsername = (this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? '').toLowerCase();
    const botAdded = msg.new_chat_members?.some((m) => m.is_bot && m.username?.toLowerCase() === botUsername) ?? false;
    if (!botAdded) return;
    await this.telegram.sendMessage(String(msg.chat.id), this.groupSetupText(msg.chat.title), { replyMarkup: this.privateStartKeyboard() });
  }

  private async sendConnectLink(chatType: string, chatId: string, telegramUserId: string, url: string) {
    const text = [
      'Connect your brokerage with SnapTrade read-only access:',
      url,
      '',
      'TradePing can read executed trades and positions for alerts. It cannot place trades, move money, or see your brokerage password.',
      'Broker freshness depends on the broker. Fidelity/IBKR may be delayed up to 24h.',
      '',
      'The link expires in about 5 minutes. Run /disconnect anytime to revoke access.',
    ].join('\n');
    if (chatType === 'private') {
      await this.telegram.sendMessage(chatId, text);
      return;
    }
    try {
      await this.telegram.sendMessage(telegramUserId, text);
      await this.telegram.sendMessage(chatId, 'Sent your private connection link in DM.');
    } catch {
      await this.telegram.sendMessage(
        chatId,
        'I can\'t DM you yet. Tap <b>Start private setup</b>, press Start, then run /connect here again.',
        { replyMarkup: this.privateStartKeyboard() },
      );
    }
  }

  private async sendReconnectLink(chatType: string, chatId: string, telegramUserId: string, url: string) {
    const text = [
      'Repair your existing read-only brokerage connection:',
      url,
      '',
      'Use the same brokerage login you linked before. Repairing it preserves your existing connection history and avoids duplicates.',
      '',
      'The link expires in about 5 minutes.',
    ].join('\n');
    if (chatType === 'private') {
      await this.telegram.sendMessage(chatId, text);
      return;
    }
    try {
      await this.telegram.sendMessage(telegramUserId, text);
      await this.telegram.sendMessage(chatId, 'Sent your private reconnect link in DM.');
    } catch {
      await this.telegram.sendMessage(chatId, 'I can\'t DM you yet. Tap <b>Start private setup</b>, press Start, then run /reconnect here again.', { replyMarkup: this.privateStartKeyboard() });
    }
  }

  private helpText(chatType: string) {
    if (chatType === 'private') {
      return [
        'TradePing is ready for private setup.',
        '',
        'Next steps:',
        '1. Go back to your TradePing group.',
        '2. Run /connect there.',
        '3. I will DM your private read-only brokerage link.',
        '',
        'Use /trust in the group to see exactly what is bot-level, user-level, and group-level.',
      ].join('\n');
    }
    return [
      'TradePing posts read-only trade alerts to this group.',
      '',
      '/connect — connect a read-only brokerage',
      '/reconnect — repair a disabled brokerage connection',
      '/privacy — public, normal, private, or off',
      '/trust — what data is bot, user, and group level',
      '/diagnostics — explain what TradePing sees right now',
      '/groupstatus — group setup and alert health',
      '/setup — post the group onboarding guide again',
      '/status — linked accounts and alert health for this group',
      '/inferred — admin toggle for provisional Robinhood holdings alerts',
      '/disconnect — remove your connections',
      '',
      'Normal setup: tap Start private setup once, then run /connect here. After that, alerts are automatic.',
      'Broker freshness varies. Fidelity/IBKR may be delayed up to 24h.',
    ].join('\n');
  }

  private statusText(
    connections: Array<{ status: string; brokerageName: string | null; brokerageSlug: string | null; accounts?: Array<{ id: string; accountType: string | null }> }>,
    syncStates: Map<string, Date>,
    executionFreshness = new Map<string, { createdAt: Date; tradeTime: Date }>(),
  ) {
    if (!connections.length) return 'No brokerage connected. Run /connect to get started.';
    const label: Record<string, string> = {
      ACTIVE: 'connected (read-only)',
      PENDING: 'finishing connection…',
      ERROR: 'needs reconnect — run /reconnect',
      DISABLED: 'disabled by your broker — run /reconnect',
    };
    const lines = connections.map((c) => {
      const name = this.escape(c.brokerageName ?? c.brokerageSlug ?? 'Brokerage');
      const accountTypes = [...new Set((c.accounts ?? []).flatMap((account) => {
        const label = this.accountTypeLabel(account.accountType);
        return label ? [label] : [];
      }))];
      const suffix = accountTypes.length ? `; accounts: ${accountTypes.join(', ')}` : '';
      const lastChecked = this.lastChecked(c.accounts ?? [], syncStates);
      const checked = lastChecked ? `; last checked ${this.relativeTime(lastChecked)}` : '';
      const executionFeed = this.executionFeedSummary(c.accounts ?? [], executionFreshness);
      const feed = executionFeed ? `\nExecution feed: ${executionFeed}` : '';
      return `${name} — ${label[c.status] ?? c.status.toLowerCase()}${suffix}${checked}${feed}\n${brokerFreshnessNote(c)}`;
    });
    return ['Your connections:', ...lines].join('\n\n');
  }

  private accountTypeLabel(type: string | null): string | null {
    if (!type) return null;
    const normalized = type.trim().toUpperCase();
    const labels: Record<string, string> = {
      DIGITALASSET: 'Crypto',
      INDIVIDUAL: 'Individual',
      NP: 'BrokerageLink',
      BROKERAGELINK: 'BrokerageLink',
      CASH: 'Cash',
      MARGIN: 'Margin',
      RETIREMENT: 'Retirement',
    };
    return labels[normalized] ?? this.escape(normalized.replace(/[_-]+/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase()));
  }

  private privacyHelpText() {
    return [
      'Set how your trades appear in this group.',
      'This is per user, per group:',
      '/privacy public  — name, symbol, quantity, execution price, total, estimated sell return and broker',
      '/privacy normal  — name, symbol, quantity, execution price, total and broker (default)',
      '/privacy private — anonymous, symbol, side and broker only',
      '/privacy off     — no alerts',
    ].join('\n');
  }

  private groupSetupText(chatTitle?: string) {
    const name = chatTitle ? `<b>${this.escape(chatTitle)}</b>` : 'this group';
    return [
      `TradePing is ready for ${name}.`,
      '',
      'To share your trades here:',
      '1. Tap <b>Start private setup</b> so I can DM you safely.',
      '2. Come back and run /connect.',
      '3. Set your group visibility with /privacy.',
      '',
      'Each member connects their own read-only brokerage. This group only receives alerts for members who connected here.',
      'Alerts depend on broker freshness. Fidelity/IBKR may be delayed up to 24h.',
      'Position-only changes stay in diagnostics unless a group admin enables clearly labeled provisional Robinhood alerts with /inferred on.',
      '',
      'Run /trust to see what is bot-level, user-level, and group-level.',
    ].join('\n');
  }

  private trustText() {
    return [
      '<b>TradePing trust model</b>',
      '',
      '<b>Bot level</b>',
      'Shared infrastructure: Telegram bot, SnapTrade API, Railway, database, Redis, and background sync.',
      '',
      '<b>User level</b>',
      'Your Telegram identity, read-only SnapTrade connection, broker accounts, and detected trades/positions. /disconnect revokes your brokerage connections.',
      '',
      '<b>Group level</b>',
      'The Telegram group destination and which connected members can post alerts here.',
      'Group alerts use broker execution records by default. A group admin can opt into clearly labeled provisional Robinhood holdings alerts with /inferred on. Fidelity/IBKR remain diagnostic-only.',
      '',
      '<b>Per-user per-group level</b>',
      '/privacy controls only your alerts in this group. You can be public here, private elsewhere, or off in another group.',
      '',
      '<b>Safety</b>',
      'TradePing uses read-only access. It cannot place trades, transfer money, or see your brokerage password.',
      '',
      '<b>Freshness</b>',
      'Alerts are best-effort near-real-time where the broker supports it. Fidelity/IBKR data may be delayed up to 24h.',
    ].join('\n');
  }

  private async diagnosticsText(userId: string, groupId?: string) {
    const connections = await this.prisma.brokerConnection.findMany({
      where: { userId, status: { not: 'DISCONNECTED' } },
      include: { accounts: { where: { status: { not: 'DISCONNECTED' } }, select: { id: true, accountType: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    const syncStates = connections.length ? await this.syncStatesFor(connections.flatMap((c) => c.accounts.map((a) => a.id))) : new Map<string, Date>();
    const executionFreshness = connections.length ? await this.executionFreshnessFor(connections.flatMap((c) => c.accounts.map((a) => a.id))) : new Map<string, { createdAt: Date; tradeTime: Date }>();
    const latest = await this.prisma.tradeEvent.findFirst({
      where: { userId, ...(groupId ? { groupId } : {}) },
      orderBy: { tradeTime: 'desc' },
      select: {
        symbol: true,
        side: true,
        tradeTime: true,
        createdAt: true,
        alertStatus: true,
        backfillStatus: true,
        rawType: true,
        rawStatus: true,
        priceSource: true,
        account: { select: { connection: { select: { brokerageName: true, brokerageSlug: true } } } },
      },
    });
    const member = groupId ? await this.prisma.groupMember.findUnique({
      where: { userId_groupId: { userId, groupId } },
      select: { privacyLevel: true, alertsEnabled: true },
    }) : null;

    const lines = ['<b>TradePing diagnostics</b>'];
    if (member) lines.push(`This group: privacy ${member.privacyLevel}; alerts ${member.alertsEnabled ? 'on' : 'off'}.`);
    lines.push(`Connections: ${connections.length ? connections.length : 'none'}.`);
    if (connections.length) lines.push(brokerFreshnessSummary(connections));
    for (const conn of connections) {
      const accountTypes = [...new Set(conn.accounts.flatMap((account) => {
        const label = this.accountTypeLabel(account.accountType);
        return label ? [label] : [];
      }))];
      const lastChecked = this.lastChecked(conn.accounts, syncStates);
      const executionFeed = this.executionFeedSummary(conn.accounts, executionFreshness);
      lines.push(`${this.escape(conn.brokerageName ?? conn.brokerageSlug ?? 'Brokerage')}: ${conn.status.toLowerCase()}${accountTypes.length ? `; ${accountTypes.join(', ')}` : ''}${lastChecked ? `; checked ${this.relativeTime(lastChecked)}` : ''}${executionFeed ? `; execution feed ${executionFeed}` : ''}.`);
    }
    if (latest) {
      const broker = latest.account?.connection?.brokerageName ?? latest.account?.connection?.brokerageSlug ?? 'broker';
      lines.push(`Latest detected here: ${latest.side} ${this.escape(latest.symbol)} via ${this.escape(broker)} at ${new Date(latest.tradeTime).toLocaleString('en-US', { timeZone: TIME.DEFAULT_TIMEZONE })}; ${latest.backfillStatus.toLowerCase()}, ${latest.alertStatus.toLowerCase()}.`);
      lines.push(this.alertExplanation(latest, member));
    } else {
      lines.push('Latest detected here: none yet.');
    }
    lines.push('If a broker is delayed, /sync cannot force data SnapTrade has not received yet.');
    return lines.join('\n');
  }

  private async groupStatusText(groupId: string) {
    const [group, members, latest, pendingAlerts, skippedInferred, failedJobs] = await Promise.all([
      this.prisma.group.findUniqueOrThrow({ where: { id: groupId }, select: { inferredAlertsEnabled: true } }),
      this.prisma.groupMember.findMany({
        where: { groupId },
        orderBy: { createdAt: 'asc' },
        select: {
          privacyLevel: true,
          alertsEnabled: true,
          user: {
            select: {
              displayName: true,
              brokerConnections: {
                where: { status: { not: 'DISCONNECTED' } },
                orderBy: { updatedAt: 'desc' },
                select: {
                  status: true,
                  brokerageName: true,
                  brokerageSlug: true,
                  accounts: {
                    where: { status: { not: 'DISCONNECTED' } },
                    select: { id: true, accountType: true },
                  },
                },
              },
            },
          },
        },
      }),
      this.prisma.tradeEvent.findFirst({
        where: { groupId },
        orderBy: { tradeTime: 'desc' },
        select: { symbol: true, side: true, tradeTime: true, createdAt: true, alertStatus: true, backfillStatus: true, rawType: true, rawStatus: true, priceSource: true },
      }),
      this.prisma.tradeEvent.count({ where: { groupId, alertStatus: 'PENDING' } }),
      this.prisma.tradeEvent.count({
        where: {
          groupId,
          alertStatus: 'SKIPPED',
          createdAt: { gte: new Date(Date.now() - 24 * 3600_000) },
          OR: [{ rawType: 'position_delta' }, { rawStatus: 'INFERRED' }],
        },
      }),
      this.prisma.auditLog.count({ where: { action: 'job_failed', createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
    ]);

    const connectedMembers = members.filter((member) => member.user.brokerConnections.some((conn) => conn.status === 'ACTIVE')).length;
    const alertsOn = members.filter((member) => member.alertsEnabled && member.privacyLevel !== 'OFF').length;
    const brokerRefs = members.flatMap((member) => member.user.brokerConnections.map((conn) => ({
      brokerageName: conn.brokerageName,
      brokerageSlug: conn.brokerageSlug,
    })));
    const syncStates = brokerRefs.length
      ? await this.syncStatesFor(members.flatMap((member) => member.user.brokerConnections.flatMap((conn) => conn.accounts.map((account) => account.id))))
      : new Map<string, Date>();
    const executionFreshness = brokerRefs.length
      ? await this.executionFreshnessFor(members.flatMap((member) => member.user.brokerConnections.flatMap((conn) => conn.accounts.map((account) => account.id))))
      : new Map<string, { createdAt: Date; tradeTime: Date }>();
    const delayed = brokerRefs.some((broker) => brokerFreshnessNote(broker).includes('delayed'));
    const lines = [
      '<b>TradePing group status</b>',
      `Known members: ${members.length}`,
      `Connected members: ${connectedMembers}`,
      `Members with alerts on: ${alertsOn}`,
      `Provisional Robinhood holdings alerts: ${group.inferredAlertsEnabled ? 'on' : 'off'}`,
      `Pending alerts: ${pendingAlerts}`,
      `Inferred trades skipped in last 24h: ${skippedInferred}`,
      `Worker failures in last 24h: ${failedJobs}`,
      delayed ? 'Freshness: at least one connected broker may be delayed up to 24h.' : 'Freshness: best-effort near-real-time when brokers report fresh data.',
    ];
    if (latest) {
      lines.push(`Latest detected: ${latest.side} ${this.escape(latest.symbol)} at ${new Date(latest.tradeTime).toLocaleString('en-US', { timeZone: TIME.DEFAULT_TIMEZONE })}; ${latest.backfillStatus.toLowerCase()}, ${latest.alertStatus.toLowerCase()}.`);
      lines.push(this.alertExplanation(latest, null));
    } else {
      lines.push('Latest detected: none yet.');
    }
    const roster = members.flatMap((member) => {
      const owner = this.escape(member.user.displayName);
      if (!member.user.brokerConnections.length) return [`${owner}: no brokerage connected.`];
      return member.user.brokerConnections.map((conn) => {
        const broker = this.escape(conn.brokerageName ?? conn.brokerageSlug ?? 'Brokerage');
        const accountTypes = [...new Set(conn.accounts.flatMap((account) => {
          const label = this.accountTypeLabel(account.accountType);
          return label ? [label] : [];
        }))];
        const accounts = accountTypes.length ? `; accounts: ${accountTypes.join(', ')}` : '; accounts: connected';
        const lastChecked = this.lastChecked(conn.accounts, syncStates);
        const checked = lastChecked ? `; last checked ${this.relativeTime(lastChecked)}` : '';
        const executionFeed = this.executionFeedSummary(conn.accounts, executionFreshness);
        const feed = executionFeed ? `; execution feed ${executionFeed}` : '';
        const alertState = member.alertsEnabled && member.privacyLevel !== 'OFF' ? member.privacyLevel.toLowerCase() : 'off';
        return `${owner}: ${broker} — ${conn.status.toLowerCase()}${accounts}; alerts ${alertState}${checked}${feed}.`;
      });
    });
    lines.push('', '<b>Linked accounts in this group</b>', ...roster);
    lines.push('Owner means the Telegram member who linked the read-only brokerage. Account names and numbers are not shown.');
    return lines.join('\n');
  }

  private alertExplanation(
    trade: {
      alertStatus: string;
      backfillStatus: string;
      rawType: string | null;
      rawStatus: string | null;
      priceSource: string | null;
      createdAt: Date;
    },
    member: { privacyLevel: string; alertsEnabled: boolean } | null,
  ): string {
    if (trade.alertStatus === 'SENT' && (trade.rawType === 'position_delta' || trade.rawStatus === 'INFERRED')) return 'Alert result: posted as a provisional holdings change because this group opted in.';
    if (trade.alertStatus === 'SENT') return 'Alert result: posted to the group.';
    if (trade.alertStatus === 'PENDING') return 'Alert result: queued for delivery.';
    if (trade.alertStatus === 'SENDING') return 'Alert result: currently being delivered.';
    if (trade.alertStatus === 'FAILED') return 'Alert result: delivery failed and will retry if still inside the retry window.';
    if (member && (!member.alertsEnabled || member.privacyLevel === 'OFF')) return 'Alert result: skipped because your alerts are off in this group.';
    if (trade.backfillStatus === 'BACKFILL') return 'Alert result: skipped as older broker history/backfill, so TradePing did not replay it into the group.';
    if (trade.rawType === 'position_delta' || trade.rawStatus === 'INFERRED') {
      return 'Alert result: skipped because TradePing saw only a holdings change, not a broker execution record. Position-only changes are diagnostic-only.';
    }
    if (trade.alertStatus === 'SKIPPED') return 'Alert result: skipped by safety policy.';
    return `Alert result: ${trade.alertStatus.toLowerCase()}.`;
  }

  private async syncStatesFor(accountIds: string[]): Promise<Map<string, Date>> {
    if (!accountIds.length) return new Map();
    const states = await this.prisma.syncState.findMany({
      where: { accountId: { in: accountIds }, key: { in: ['position_snapshot', 'last_successful_order_sync'] } },
      select: { accountId: true, updatedAt: true },
    });
    const byAccount = new Map<string, Date>();
    for (const state of states) {
      if (!state.accountId) continue;
      const prev = byAccount.get(state.accountId);
      if (!prev || state.updatedAt > prev) byAccount.set(state.accountId, state.updatedAt);
    }
    return byAccount;
  }

  private async executionFreshnessFor(accountIds: string[]): Promise<Map<string, { createdAt: Date; tradeTime: Date }>> {
    if (!accountIds.length) return new Map();
    const events = await this.prisma.tradeEvent.findMany({
      where: {
        accountId: { in: accountIds },
        NOT: [{ rawType: 'position_delta' }, { rawStatus: 'INFERRED' }],
      },
      orderBy: { createdAt: 'desc' },
      take: Math.max(accountIds.length * 4, 20),
      select: { accountId: true, createdAt: true, tradeTime: true },
    });
    const byAccount = new Map<string, { createdAt: Date; tradeTime: Date }>();
    for (const event of events) {
      if (!event.accountId || byAccount.has(event.accountId)) continue;
      byAccount.set(event.accountId, { createdAt: event.createdAt, tradeTime: event.tradeTime });
    }
    return byAccount;
  }

  private executionFeedSummary(accounts: Array<{ id: string; accountType: string | null }>, executionFreshness: Map<string, { createdAt: Date; tradeTime: Date }>): string | null {
    const summaries = accounts.flatMap((account) => {
      const latest = executionFreshness.get(account.id);
      if (!latest) return [];
      const accountLabel = this.accountTypeLabel(account.accountType) ?? 'Account';
      const lag = this.duration(latest.createdAt.getTime() - latest.tradeTime.getTime());
      return [`${accountLabel} confirmed ${this.relativeTime(latest.createdAt)}; broker lag ${lag}`];
    });
    return summaries.length ? summaries.join(', ') : null;
  }

  private lastChecked(accounts: Array<{ id: string }>, syncStates: Map<string, Date>): Date | null {
    return accounts.reduce<Date | null>((latest, account) => {
      const checked = syncStates.get(account.id);
      if (!checked) return latest;
      return !latest || checked > latest ? checked : latest;
    }, null);
  }

  private relativeTime(date: Date): string {
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 90) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 90) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  private duration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 90) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  private privateStartKeyboard() {
    const username = this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? 'tradeping_v1_bot';
    return { inline_keyboard: [[{ text: 'Start private setup', url: `https://t.me/${username}?start=setup` }]] };
  }

  private displayName(from: NonNullable<TelegramUpdate['message']>['from']) {
    return from?.username ? `@${from.username}` : [from?.first_name, from?.last_name].filter(Boolean).join(' ') || 'Telegram User';
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
