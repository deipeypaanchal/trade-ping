import { BadRequestException, Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../config/prisma.service';
import { JOB_DEFAULTS } from '../config/constants';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './telegram.types';
import { BrokerOnboardingService } from '../broker/broker-onboarding.service';
import { PrivacyService } from '../privacy/privacy.service';

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
    if (secret !== expected) throw new UnauthorizedException();
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
        await this.onboarding.refreshConnections(user.id);
        const connections = await this.prisma.brokerConnection.findMany({
          where: { userId: user.id, status: { not: 'DISCONNECTED' } },
          include: { accounts: { where: { status: { not: 'DISCONNECTED' } }, select: { accountType: true } } },
          orderBy: { updatedAt: 'desc' },
        });
        await this.telegram.sendMessage(chatId, this.statusText(connections));
      } else if (this.cmd(text, '/sync')) {
        await this.queue.add('sync-user', { userId: user.id }, { ...JOB_DEFAULTS });
        await this.telegram.sendMessage(chatId, 'Sync queued. This is just a manual check; TradePing already watches automatically in the background.');
      } else if (this.cmd(text, '/disconnect')) {
        const count = await this.onboarding.disconnectAll(user.id);
        await this.telegram.sendMessage(chatId, count ? `Disconnected ${count} brokerage connection(s). No more alerts until you /connect again.` : 'You had no active brokerage connections.');
      } else if (this.cmd(text, '/trust')) {
        await this.telegram.sendMessage(chatId, this.trustText());
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
      '/privacy — public, normal, private, or off',
      '/trust — what data is bot, user, and group level',
      '/setup — post the group onboarding guide again',
      '/status — your connection status',
      '/disconnect — remove your connections',
      '',
      'Normal setup: tap Start private setup once, then run /connect here. After that, alerts are automatic.',
    ].join('\n');
  }

  private statusText(connections: Array<{ status: string; brokerageName: string | null; brokerageSlug: string | null; accounts?: Array<{ accountType: string | null }> }>) {
    if (!connections.length) return 'No brokerage connected. Run /connect to get started.';
    const label: Record<string, string> = {
      ACTIVE: 'connected (read-only)',
      PENDING: 'finishing connection…',
      ERROR: 'needs reconnect — run /connect',
      DISABLED: 'disabled by your broker — run /connect',
    };
    const lines = connections.map((c) => {
      const name = this.escape(c.brokerageName ?? c.brokerageSlug ?? 'Brokerage');
      const accountTypes = [...new Set((c.accounts ?? []).flatMap((account) => {
        const label = this.accountTypeLabel(account.accountType);
        return label ? [label] : [];
      }))];
      const suffix = accountTypes.length ? `; accounts: ${accountTypes.join(', ')}` : '';
      return `${name} — ${label[c.status] ?? c.status.toLowerCase()}${suffix}`;
    });
    return ['Your connections:', ...lines].join('\n');
  }

  private accountTypeLabel(type: string | null): string | null {
    if (!type) return null;
    const normalized = type.trim().toUpperCase();
    const labels: Record<string, string> = {
      DIGITALASSET: 'Crypto',
      INDIVIDUAL: 'Individual',
    };
    return labels[normalized] ?? this.escape(normalized.replace(/[_-]+/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase()));
  }

  private privacyHelpText() {
    return [
      'Set how your trades appear in this group.',
      'This is per user, per group:',
      '/privacy public  — name, symbol, quantity, avg price, value and broker',
      '/privacy normal  — name, symbol, quantity, value and broker (default)',
      '/privacy private — anonymous, symbol only',
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
      '',
      '<b>Per-user per-group level</b>',
      '/privacy controls only your alerts in this group. You can be public here, private elsewhere, or off in another group.',
      '',
      '<b>Safety</b>',
      'TradePing uses read-only access. It cannot place trades, transfer money, or see your brokerage password.',
    ].join('\n');
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
